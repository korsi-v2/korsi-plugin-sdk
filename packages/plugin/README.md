# @korsi/plugin

The server side of a [Korsi](https://korsi.ai) plugin, for Node 20.19+: the same surface as the
Python SDK `korsi-plugin`.

```ts
import express from 'express';
import { KorsiPlugin, RequestRejected, KorsiRefused, Topic, headerValue } from '@korsi/plugin';

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
    });
  res.json({ status });
});

app.post('/korsi/tools/:name', raw, async (req, res) => {
  const { installation, call } = await plugin.toolCall(req.params.name, req.body,
    headerValue(req.headers, 'korsi-signature'));
  const korsi = plugin.client(installation, call.handle); // as the person
  res.json({ content: (await korsi.records('thread')).items });
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
