# @korsi/plugin

The server side of a [Korsi](https://korsi.ai) plugin, for Node 20.19+: the same surface as the
Python SDK `korsi-plugin`, except a durable event log -- `MemoryEventLog` forgets on a restart, so
give `{ events }` your own `EventLog` (three methods) over the database you already have.

```ts
import express from 'express';
import { KorsiPlugin, RequestRejected, KorsiRefused, Topic, SYNC, VERIFY, headerValue } from '@korsi/plugin';

const plugin = new KorsiPlugin(store); // your InstallationStore; { events } for a durable EventLog
const app = express();
const raw = express.raw({ type: 'application/json' }); // verify the bytes Korsi signed

app.post('/korsi/lifecycle', raw, async (req, res) => {
  const result = await plugin.lifecycle(req.body, headerValue(req.headers, 'korsi-signature'));
  res.json({ status: result.status });
});

app.post('/korsi/events', raw, async (req, res) => {
  const status = await plugin.event(req.body, headerValue(req.headers, 'korsi-signature'),
    async (installation, event) => {
      if (event.topic === Topic.proposalSettled) { /* ... */ }
      if (event.topic === Topic.mailReceived) {
        // A person's mail, read as them with the handle Korsi minted for this delivery.
        const mail = await plugin.client(installation, event.handle!).readMail(event.subjectId!);
      }
    });
  res.json({ status });
});

app.post('/korsi/tools/:name', raw, async (req, res) => {
  const { installation, call } = await plugin.toolCall(req.params.name, req.body,
    headerValue(req.headers, 'korsi-signature'));
  const korsi = plugin.client(installation, call.handle); // as the person
  res.json({ content: (await korsi.records('thread')).items });
});

// An integration plugin (ADR-0067): Korsi asks about a person's connected account.
app.post('/korsi/connections', raw, async (req, res) => {
  const { call } = await plugin.connectionCall(req.body, headerValue(req.headers, 'korsi-signature'));
  if (call.call === VERIFY) res.json(await checkAccount(call.values, call.secrets)); // never log secrets
  else if (call.call === SYNC) res.json(await changesSince(call.state, call.limits));
  else res.json({ result: await onCalendar(call.op, call.args) });
});

app.get('/api/me', async (req, res) => {
  const who = await plugin.person({
    authorization: req.headers.authorization,
    installationId: headerValue(req.headers, 'x-korsi-installation'),
  });
  res.json(await plugin.client(who.installation, who.handle).wallet());
});

app.use((error, req, res, next) => {
  if (error instanceof RequestRejected) return res.status(error.status).json({ detail: error.message });
  if (error instanceof KorsiRefused) return res.status(error.status).json({ code: error.code });
  next(error);
});
```

`KorsiClient` covers every route of `/plugin/v1`, typed from Korsi's OpenAPI document. Amounts of
MU stay decimal strings; `Wallet.covers` and `compareAmounts` compare them exactly.
