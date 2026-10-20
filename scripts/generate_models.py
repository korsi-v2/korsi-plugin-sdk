"""Write the plugin plane's types and calls, for both SDKs, from Korsi's own OpenAPI document.

    python3 scripts/generate_models.py          # rewrite the generated files
    python3 scripts/generate_models.py --check  # fail if they are not what the document says

The document is ``openapi/plugin-v1.json``: a copy of ``/plugin/v1/openapi.json``, which Korsi
generates from the same models it validates with (``scripts/sync-openapi.sh`` refreshes it). The
types follow it exactly, with one rule of FastAPI's added: Korsi writes every field of what it
answers, defaults and nulls included, so in a schema that only ever comes *back* from Korsi every
field is required here -- nobody writes ``page.get("items", [])`` for a list Korsi never leaves
out. A field is optional only where the plugin may leave it out of what it sends.

**The calls are generated too.** Every route of the plane becomes a method of the client, named
after the function Korsi serves it with (the ``operationId`` FastAPI derives from it):
``GET /cases`` served by ``list_cases`` is ``list_cases()`` in Python and ``listCases()`` in
TypeScript, with its path parameters positional, its query parameters by keyword, and its body
typed. A page with ``items`` and ``next_cursor`` that takes a ``cursor`` also gets an iterator over
every item (``iter_cases()``). A route Korsi adds is in the SDK the moment the document is synced
and this runs again -- nobody writes it by hand.

The exceptions are the routes in :data:`HAND_WRITTEN`: the plane's first ones, which the clients
wrap in something better than the raw call (``whoami()`` reads the caller into ids,
``consume()`` takes an exact quantity, ``record()`` is ``None`` when there is none). The
generator leaves those to the client and fails if one of them disappears from the document, or if
a generated name would collide with something the client already has.

Standard library only, so it runs before anything is installed.
"""

from __future__ import annotations

import argparse
import json
import keyword
import re
import sys
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DOCUMENT = ROOT / "openapi" / "plugin-v1.json"
PYTHON_DIR = ROOT / "python" / "src" / "korsi_plugin"
TS_DIR = ROOT / "packages" / "plugin" / "src"
PREFIX = "/plugin/v1"

#: Routes the clients wrap by hand, and the method each is: (Python, TypeScript).
HAND_WRITTEN: dict[tuple[str, str], tuple[str, str]] = {
    ("GET", "/installation"): ("whoami", "whoami"),
    ("GET", "/people"): ("people", "people"),
    ("GET", "/records/{type_key}"): ("records", "records"),
    ("GET", "/records/{type_key}/{external_id}"): ("record", "record"),
    ("PUT", "/records/{type_key}/{external_id}"): ("put_record", "putRecord"),
    ("DELETE", "/records/{type_key}/{external_id}"): ("delete_record", "deleteRecord"),
    ("POST", "/proposals"): ("propose", "propose"),
    ("GET", "/proposals"): ("proposals", "proposals"),
    ("GET", "/proposals/{proposal_id}"): ("proposal", "proposal"),
    ("POST", "/sources"): ("bring_in", "bringIn"),
    ("GET", "/wallet"): ("wallet", "wallet"),
    ("POST", "/wallet/holds"): ("open_hold", "openHold"),
    ("POST", "/wallet/holds/{hold_id}/settle"): ("settle_hold", "settleHold"),
    ("POST", "/wallet/holds/{hold_id}/release"): ("release_hold", "releaseHold"),
    ("POST", "/wallet/consume"): ("consume", "consume"),
    ("GET", "/events"): ("events", "events"),
}

#: Everything else the clients have: a generated method may not take one of these names.
RESERVED_PY = frozenset(
    {name for name, _ in HAND_WRITTEN.values()}
    | {"iter_records", "iter_events", "reserve", "aclose", "api_base", "plugin_api", "_call"}
)
RESERVED_TS = frozenset(
    {name for _, name in HAND_WRITTEN.values()}
    | {"iterRecords", "iterEvents", "reserve", "apiBase", "pluginApi", "call"}
)

#: FastAPI's own validation envelope: Korsi answers problems instead, so neither is used.
SKIPPED = frozenset({"HTTPValidationError", "ValidationError"})

Schema = Mapping[str, Any]


def _ref_name(schema: Schema) -> str | None:
    ref = schema.get("$ref")
    return ref.rsplit("/", 1)[-1] if isinstance(ref, str) else None


def _refs(schema: Any) -> Iterable[str]:
    if isinstance(schema, Mapping):
        name = _ref_name(schema)
        if name:
            yield name
        for value in schema.values():
            yield from _refs(value)
    elif isinstance(schema, list):
        for value in schema:
            yield from _refs(value)


def _closure(names: Iterable[str], schemas: Mapping[str, Schema]) -> set[str]:
    seen: set[str] = set()
    todo = list(names)
    while todo:
        name = todo.pop()
        if name in seen or name not in schemas:
            continue
        seen.add(name)
        todo.extend(_refs(schemas[name]))
    return seen


def _directions(document: Schema) -> tuple[set[str], set[str]]:
    """The schemas reachable from request bodies, and those reachable from responses."""
    schemas = document["components"]["schemas"]
    sent: list[str] = []
    received: list[str] = []
    for operations in document["paths"].values():
        for operation in operations.values():
            sent.extend(_refs(operation.get("requestBody", {})))
            for status, response in operation.get("responses", {}).items():
                if str(status).startswith("2"):
                    received.extend(_refs(response))
    return _closure(sent, schemas), _closure(received, schemas)


def _is_decimal(schema: Schema) -> bool:
    """Korsi's amounts: a JSON string of a decimal, or (accepted on the way in) a number."""
    options = schema.get("anyOf", [])
    kinds = {option.get("type") for option in options}
    if kinds == {"number", "string"}:
        return True
    return schema.get("type") == "string" and "pattern" in schema and "\\d" in schema["pattern"]


def _first_line(text: str | None) -> str:
    return (text or "").strip().split("\n", 1)[0].strip()


# -- Python -----------------------------------------------------------------------------------------


def _py_type(schema: Schema) -> str:
    name = _ref_name(schema)
    if name:
        return name
    if "anyOf" in schema:
        options = [option for option in schema["anyOf"] if option.get("type") != "null"]
        nullable = len(options) != len(schema["anyOf"])
        if {option.get("type") for option in options} == {"number", "string"}:
            inner = "Amount"
        else:
            inner = " | ".join(dict.fromkeys(_py_type(option) for option in options))
        return f"{inner} | None" if nullable else inner
    if "enum" in schema:
        return "Literal[" + ", ".join(json.dumps(value) for value in schema["enum"]) + "]"
    kind = schema.get("type")
    if kind == "array":
        return f"list[{_py_type(schema.get('items', {}))}]"
    if kind == "object":
        return "dict[str, Any]"
    if kind == "string":
        return "str"
    if kind == "integer":
        return "int"
    if kind == "number":
        return "float"
    if kind == "boolean":
        return "bool"
    return "Any"


def python_module(document: Schema) -> str:
    schemas = document["components"]["schemas"]
    _, received = _directions(document)
    sent, _ = _directions(document)
    lines = [
        '"""The plugin plane\'s types, as Korsi\'s OpenAPI document gives them.',
        "",
        "GENERATED by ``scripts/generate_models.py`` from ``openapi/plugin-v1.json`` "
        f"(plugin API {document['info']['version']}).",
        "Do not edit: change Korsi, refresh the document, generate again.",
        "",
        "Each is a ``TypedDict``: what travels is plain JSON, and these say what is in it. Ids and",
        "times are strings, as they are on the wire; amounts of MU are decimal strings (:data:`Amount`",
        "also accepts a number on the way in).",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "from typing import Any, Literal, NotRequired, TypedDict",
        "",
        "#: An amount: Korsi sends a decimal string, and accepts a string or a number.",
        "Amount = str | float",
        "",
    ]
    enums = sorted(name for name, schema in schemas.items() if "enum" in schema)
    for name in enums:
        values = ", ".join(json.dumps(value) for value in schemas[name]["enum"])
        lines.append(f"{name} = Literal[{values}]")
    for name in sorted(schemas):
        schema = schemas[name]
        if name in SKIPPED or "enum" in schema:
            continue
        only_received = name in received and name not in sent
        required = set(schema.get("required", []))
        lines.extend(["", ""])
        lines.append(f"class {name}(TypedDict):")
        description = _first_line(schema.get("description"))
        if description:
            lines.append(f'    """{description}"""')
            lines.append("")
        properties = schema.get("properties", {})
        if not properties:
            lines.append("    pass")
        for field, spec in properties.items():
            kind = _py_type(spec)
            if _is_decimal(spec) and "anyOf" not in spec:
                kind = "str"
            present = field in required or only_received
            comment = _first_line(spec.get("description"))
            if comment:
                lines.append(f"    #: {comment}")
            lines.append(f"    {field}: {kind if present else f'NotRequired[{kind}]'}")
    lines.append("")
    names = sorted(name for name in schemas if name not in SKIPPED)
    lines.append("__all__ = [")
    for name in ["Amount", *names]:
        lines.append(f'    "{name}",')
    lines.append("]")
    lines.append("")
    return "\n".join(lines)


# -- TypeScript -------------------------------------------------------------------------------------


def _ts_type(schema: Schema) -> str:
    name = _ref_name(schema)
    if name:
        return name
    if "anyOf" in schema:
        options = [option for option in schema["anyOf"] if option.get("type") != "null"]
        nullable = len(options) != len(schema["anyOf"])
        if {option.get("type") for option in options} == {"number", "string"}:
            inner = "Amount"
        else:
            inner = " | ".join(dict.fromkeys(_ts_type(option) for option in options))
        return f"{inner} | null" if nullable else inner
    if "enum" in schema:
        return " | ".join(json.dumps(value) for value in schema["enum"])
    kind = schema.get("type")
    if kind == "array":
        inner = _ts_type(schema.get("items", {}))
        return f"Array<{inner}>"
    if kind == "object":
        return "Record<string, unknown>"
    if kind == "string":
        return "string"
    if kind in ("integer", "number"):
        return "number"
    if kind == "boolean":
        return "boolean"
    return "unknown"


def ts_module(document: Schema) -> str:
    schemas = document["components"]["schemas"]
    sent, received = _directions(document)
    lines = [
        "/**",
        " * The plugin plane's types, as Korsi's OpenAPI document gives them.",
        " *",
        " * GENERATED by `scripts/generate_models.py` from `openapi/plugin-v1.json` "
        f"(plugin API {document['info']['version']}).",
        " * Do not edit: change Korsi, refresh the document, generate again.",
        " *",
        " * Ids and times are strings, as they are on the wire; amounts of MU are decimal strings",
        " * (`Amount` also accepts a number on the way in).",
        " */",
        "",
        "/** An amount: Korsi sends a decimal string, and accepts a string or a number. */",
        "export type Amount = string | number;",
        "",
    ]
    for name in sorted(name for name, schema in schemas.items() if "enum" in schema):
        values = " | ".join(json.dumps(value) for value in schemas[name]["enum"])
        lines.append(f"export type {name} = {values};")
    for name in sorted(schemas):
        schema = schemas[name]
        if name in SKIPPED or "enum" in schema:
            continue
        only_received = name in received and name not in sent
        required = set(schema.get("required", []))
        lines.append("")
        description = _first_line(schema.get("description"))
        if description:
            lines.append(f"/** {description} */")
        lines.append(f"export interface {name} {{")
        for field, spec in schema.get("properties", {}).items():
            kind = _ts_type(spec)
            if _is_decimal(spec) and "anyOf" not in spec:
                kind = "string"
            present = field in required or only_received
            comment = _first_line(spec.get("description"))
            if comment:
                lines.append(f"  /** {comment} */")
            lines.append(f"  {field}{'' if present else '?'}: {kind};")
        lines.append("}")
    lines.append("")
    return "\n".join(lines)


# -- Operations -------------------------------------------------------------------------------------


class GenerationError(Exception):
    pass


def _snake(text: str) -> str:
    text = re.sub(r"[^0-9a-zA-Z]+", "_", text)
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", text).strip("_").lower()


def _camel(text: str) -> str:
    head, *rest = _snake(text).split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def _function_name(operation: Schema, path: str, method: str) -> str:
    """The name of the function Korsi serves the route with, from FastAPI's ``operationId``
    (``<function><path, non-word characters as _>_<method>``)."""
    operation_id = str(operation.get("operationId") or "")
    suffix = re.sub(r"\W", "_", path) + "_" + method.lower()
    if operation_id.endswith(suffix) and len(operation_id) > len(suffix):
        return _snake(operation_id[: -len(suffix)])
    if operation_id:
        return _snake(operation_id)
    msg = f"{method.upper()} {path} has no operationId to name it by"
    raise GenerationError(msg)


def _resolve(document: Schema, schema: Schema) -> Schema:
    name = _ref_name(schema)
    return document["components"]["schemas"][name] if name else schema


def _response(operation: Schema) -> Schema | None:
    for status in sorted(operation.get("responses", {})):
        if str(status).startswith("2"):
            content = operation["responses"][status].get("content") or {}
            media = content.get("application/json")
            return media.get("schema") if media else None
    return None


def _body(operation: Schema) -> Schema | None:
    content = (operation.get("requestBody") or {}).get("content") or {}
    media = content.get("application/json")
    return media.get("schema") if media else None


class Operation:
    """One route of the plane, as the generators need it."""

    def __init__(self, document: Schema, method: str, path: str, spec: Schema) -> None:
        self.method = method.upper()
        self.path = path.removeprefix(PREFIX) or "/"
        self.name = _function_name(spec, path, method)
        self.summary = _first_line(spec.get("summary") or spec.get("description"))
        parameters = spec.get("parameters", [])
        self.path_params = [p for p in parameters if p.get("in") == "path"]
        self.query_params = [p for p in parameters if p.get("in") == "query"]
        self.body = _body(spec)
        self.response = _response(spec)
        # Pages: {items, next_cursor} answered to a request that takes a cursor.
        self.item: Schema | None = None
        if self.response and any(p["name"] == "cursor" for p in self.query_params):
            page = _resolve(document, self.response)
            properties = page.get("properties", {})
            if "next_cursor" in properties and properties.get("items", {}).get("type") == "array":
                self.item = properties["items"].get("items", {})

    @property
    def key(self) -> tuple[str, str]:
        return (self.method, self.path)

    @property
    def iterator(self) -> str:
        base = self.name.removeprefix("list_")
        return f"iter_{base}"


def operations(document: Schema) -> list[Operation]:
    found = [
        Operation(document, method, path, spec)
        for path, methods in document["paths"].items()
        for method, spec in methods.items()
        if method.lower() in {"get", "post", "put", "patch", "delete"}
    ]
    keys = {operation.key for operation in found}
    gone = [key for key in HAND_WRITTEN if key not in keys]
    if gone:
        listed = ", ".join(f"{method} {path}" for method, path in gone)
        msg = f"Korsi no longer serves {listed}: remove its hand-written method from the clients"
        raise GenerationError(msg)
    generated = [operation for operation in found if operation.key not in HAND_WRITTEN]
    seen: dict[str, tuple[str, str]] = {}
    for operation in generated:
        names = [operation.name] + ([operation.iterator] if operation.item else [])
        for name in names:
            if name in RESERVED_PY or _camel(name) in RESERVED_TS or name in seen:
                msg = f"{operation.method} {operation.path} would be {name}(), which is taken"
                raise GenerationError(msg)
            seen[name] = operation.key
    return sorted(found, key=lambda operation: (operation.path, operation.method))


def _segments(path: str, rename: Mapping[str, str], template: str) -> str:
    return re.sub(r"\{(\w+)\}", lambda match: template.format(rename[match.group(1)]), path)


def _py_param_type(schema: Schema) -> str:
    options = [option for option in schema.get("anyOf", [schema]) if option.get("type") != "null"]
    kinds = []
    for option in options:
        fmt = option.get("format")
        if fmt == "uuid":
            kinds.append("str | uuid.UUID")
        elif fmt == "date-time":
            kinds.append("str | datetime")
        elif fmt == "date":
            kinds.append("str | date")
        else:
            kinds.append(_py_type(option))
    return " | ".join(dict.fromkeys(kinds)) or "Any"


def _py_name(name: str) -> str:
    snake = _snake(name)
    return f"{snake}_" if keyword.iskeyword(snake) else snake


def _py_keyword(name: str, parameter: Schema) -> str:
    kind = _py_param_type(parameter["schema"])
    return f"{name}: {kind}" if parameter.get("required") else f"{name}: {kind} | None = None"


def python_operations(document: Schema) -> str:
    found = operations(document)
    used: set[str] = set()
    methods: list[str] = []
    for operation in found:
        if operation.key in HAND_WRITTEN:
            continue
        path_names = {p["name"]: _py_name(p["name"]) for p in operation.path_params}
        query_names = {p["name"]: _py_name(p["name"]) for p in operation.query_params}
        for parameter in operation.path_params + operation.query_params:
            used.update(_refs(parameter.get("schema", {})))
        arguments = [f"{path_names[p['name']]}: {_py_param_type(p['schema'])}" for p in operation.path_params]
        if operation.body is not None:
            body_type = _ref_name(operation.body) or "dict[str, Any]"
            used.add(body_type)
            arguments.append(f"body: {body_type}")
        keyword_arguments = [_py_keyword(query_names[p["name"]], p) for p in operation.query_params]
        returns = _ref_name(operation.response) if operation.response else None
        returns = returns or ("None" if operation.response is None else "Any")
        if returns not in ("None", "Any"):
            used.add(returns)
        signature = ", ".join(["self", *arguments, *(["*", *keyword_arguments] if keyword_arguments else [])])
        path = _segments(operation.path, path_names, "{{_segment({})}}")
        call = [f'"{operation.method}"', f'f"{path}"' if "{" in path else f'"{path}"']
        if operation.query_params:
            pairs = ", ".join(f'"{name}": {python}' for name, python in query_names.items())
            call.append(f"params={{{pairs}}}")
        if operation.body is not None:
            call.append("json=dict(body)" if _ref_name(operation.body) else "json=body")
        methods.append("")
        methods.append(f"    async def {operation.name}({signature}) -> {returns}:")
        methods.append(f'        """{operation.method} {operation.path}: {operation.summary or operation.name}."""')
        if returns == "None":
            methods.append(f"        await self._call({', '.join(call)})")
        else:
            methods.append(f"        return cast({returns}, await self._call({', '.join(call)}))")
        if operation.item is not None:
            item_type = _ref_name(operation.item) or "Any"
            if item_type != "Any":
                used.add(item_type)
            rest = [p for p in operation.query_params if p["name"] != "cursor"]
            iter_arguments = [a for a in arguments]
            iter_keywords = [_py_keyword(query_names[p["name"]], p) for p in rest]
            iter_signature = ", ".join(["self", *iter_arguments, *(["*", *iter_keywords] if iter_keywords else [])])
            forwarded = [path_names[p["name"]] for p in operation.path_params]
            forwarded += [f"{query_names[p['name']]}={query_names[p['name']]}" for p in rest]
            forwarded.append("cursor=cursor")
            methods.append("")
            methods.append(f"    async def {operation.iterator}({iter_signature}) -> AsyncIterator[{item_type}]:")
            methods.append(f'        """Every item of :meth:`{operation.name}`, page by page."""')
            methods.append("        cursor: str | None = None")
            methods.append("        while True:")
            methods.append(f"            page = await self.{operation.name}({', '.join(forwarded)})")
            methods.append('            for item in page["items"]:')
            methods.append("                yield item")
            methods.append('            cursor = page.get("next_cursor")')
            methods.append("            if not cursor:")
            methods.append("                return")
    routes = []
    for operation in found:
        name = HAND_WRITTEN[operation.key][0] if operation.key in HAND_WRITTEN else operation.name
        routes.append(f'    ("{operation.method}", "{operation.path}"): "{name}",')
    imports = ", ".join(sorted(used))
    lines = [
        '"""The plugin plane\'s calls, as Korsi\'s OpenAPI document gives them.',
        "",
        "GENERATED by ``scripts/generate_models.py`` from ``openapi/plugin-v1.json`` "
        f"(plugin API {document['info']['version']}).",
        "Do not edit: change Korsi, refresh the document, generate again.",
        "",
        "One method per route, named after the function Korsi serves it with. The routes in the",
        "generator's ``HAND_WRITTEN`` are :class:`korsi_plugin.KorsiClient`'s own, wrapped in something",
        "better than the raw call; :data:`ROUTES` names the method of every route, either way.",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "import uuid",
        "from collections.abc import AsyncIterator, Mapping",
        "from datetime import date, datetime",
        "from typing import TYPE_CHECKING, Any, Final, cast",
        "from urllib.parse import quote",
        "",
    ]
    if imports:
        lines.append(f"from .models import {imports}")
        lines.append("")
    lines += [
        "#: Every route of the plane, and the client method that calls it.",
        "ROUTES: Final[Mapping[tuple[str, str], str]] = {",
        *routes,
        "}",
        "",
        "",
        "def _segment(value: object) -> str:",
        '    return quote(str(value), safe="")',
        "",
        "",
        "class PlaneOperations:",
        '    """The generated half of :class:`korsi_plugin.KorsiClient`."""',
        "",
        "    if TYPE_CHECKING:",
        "",
        "        async def _call(",
        "            self,",
        "            method: str,",
        "            path: str,",
        "            *,",
        "            json: Any = None,",
        "            params: Mapping[str, Any] | None = None,",
        "        ) -> Any: ...",
        *methods,
        "",
        "",
        "__all__ = [\"ROUTES\", \"PlaneOperations\"]",
        "",
    ]
    return "\n".join(lines)


def _ts_param_type(schema: Schema) -> str:
    options = [option for option in schema.get("anyOf", [schema]) if option.get("type") != "null"]
    kinds = []
    for option in options:
        if option.get("format") in ("date-time", "date"):
            kinds.append("string | Date")
        else:
            kinds.append(_ts_type(option))
    return " | ".join(dict.fromkeys(kinds)) or "unknown"


def _ts_options(names: Mapping[str, str], parameters: list[Schema]) -> str:
    fields = " ".join(
        f"{names[p['name']]}: {_ts_param_type(p['schema'])};"
        if p.get("required")
        else f"{names[p['name']]}?: {_ts_param_type(p['schema'])} | null;"
        for p in parameters
    )
    required = any(p.get("required") for p in parameters)
    return f"options: {{ {fields} }}" + ("" if required else " = {}")


def ts_operations(document: Schema) -> str:
    found = operations(document)
    used: set[str] = set()
    methods: list[str] = []
    for operation in found:
        if operation.key in HAND_WRITTEN:
            continue
        name = _camel(operation.name)
        path_names = {p["name"]: _camel(p["name"]) for p in operation.path_params}
        query_names = {p["name"]: _camel(p["name"]) for p in operation.query_params}
        for parameter in operation.path_params + operation.query_params:
            used.update(_refs(parameter.get("schema", {})))
        arguments = [f"{path_names[p['name']]}: string" for p in operation.path_params]
        if operation.body is not None:
            body_type = _ref_name(operation.body) or "Record<string, unknown>"
            if _ref_name(operation.body):
                used.add(body_type)
            arguments.append(f"body: {body_type}")
        if operation.query_params:
            arguments.append(_ts_options(query_names, operation.query_params))
        returns = _ref_name(operation.response) if operation.response else None
        returns = returns or ("void" if operation.response is None else "unknown")
        if returns not in ("void", "unknown"):
            used.add(returns)
        path = _segments(operation.path, path_names, "${{segment({})}}")
        call = [f"'{operation.method}'", f"`{path}`" if "${" in path else f"'{path}'"]
        extras = []
        if operation.query_params:
            pairs = ", ".join(f"{name}: options.{ts}" for name, ts in query_names.items())
            extras.append(f"params: {{ {pairs} }}")
        if operation.body is not None:
            extras.append("json: body")
        if extras:
            call.append("{ " + ", ".join(extras) + " }")
        methods.append("")
        methods.append(f"  /** {operation.method} {operation.path}: {operation.summary or operation.name}. */")
        methods.append(f"  {name}({', '.join(arguments)}): Promise<{returns}> {{")
        methods.append(f"    return this.call<{returns}>({', '.join(call)});")
        methods.append("  }")
        if operation.item is not None:
            item_type = _ref_name(operation.item) or "unknown"
            if item_type != "unknown":
                used.add(item_type)
            iterator = _camel(operation.iterator)
            rest = [p for p in operation.query_params if p["name"] != "cursor"]
            iter_arguments = [f"{path_names[p['name']]}: string" for p in operation.path_params]
            iter_arguments.append(_ts_options(query_names, rest))
            forwarded = [path_names[p["name"]] for p in operation.path_params]
            forwarded.append("{ ...options, cursor }")
            methods.append("")
            methods.append(f"  /** Every item of `{name}`, page by page. */")
            methods.append(f"  async *{iterator}({', '.join(iter_arguments)}): AsyncGenerator<{item_type}> {{")
            methods.append("    let cursor: string | null = null;")
            methods.append("    do {")
            methods.append(f"      const page: {returns} = await this.{name}({', '.join(forwarded)});")
            methods.append("      yield* page.items;")
            methods.append("      cursor = page.next_cursor ?? null;")
            methods.append("    } while (cursor);")
            methods.append("  }")
    routes = []
    for operation in found:
        name = HAND_WRITTEN[operation.key][1] if operation.key in HAND_WRITTEN else _camel(operation.name)
        routes.append(f"  '{operation.method} {operation.path}': '{name}',")
    lines = [
        "/**",
        " * The plugin plane's calls, as Korsi's OpenAPI document gives them.",
        " *",
        " * GENERATED by `scripts/generate_models.py` from `openapi/plugin-v1.json` "
        f"(plugin API {document['info']['version']}).",
        " * Do not edit: change Korsi, refresh the document, generate again.",
        " *",
        " * One method per route, named after the function Korsi serves it with. The routes in the",
        " * generator's `HAND_WRITTEN` are `KorsiClient`'s own, wrapped in something better than the raw",
        " * call; `ROUTES` names the method of every route, either way.",
        " */",
    ]
    if used:
        lines.append(f"import type {{ {', '.join(sorted(used))} }} from './models.js';")
    lines += [
        "",
        "/** Every route of the plane, and the client method that calls it. */",
        "export const ROUTES = Object.freeze({",
        *routes,
        "} as const);",
        "",
        "/** What a call carries besides its method and path. */",
        "export interface CallOptions {",
        "  json?: unknown;",
        "  params?: Record<string, unknown>;",
        "}",
        "",
        "const segment = (value: string): string => encodeURIComponent(value);",
        "",
        "/** The generated half of `KorsiClient`. */",
        "export abstract class PlaneOperations {",
        "  protected abstract call<T>(method: string, path: string, options?: CallOptions): Promise<T>;",
        *methods,
        "}",
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--check", action="store_true", help="fail if a generated file is stale")
    parser.add_argument("--document", type=Path, default=DOCUMENT, help="another document")
    parser.add_argument("--python-out", type=Path, default=PYTHON_DIR, help="another directory")
    parser.add_argument("--ts-out", type=Path, default=TS_DIR, help="another directory")
    args = parser.parse_args(argv)
    document = json.loads(args.document.read_text(encoding="utf-8"))
    try:
        outputs = {
            args.python_out / "models.py": python_module(document),
            args.python_out / "operations.py": python_operations(document),
            args.ts_out / "models.ts": ts_module(document),
            args.ts_out / "operations.ts": ts_operations(document),
        }
    except GenerationError as error:
        print(f"cannot generate: {error}", file=sys.stderr)
        return 2
    stale = [path for path, text in outputs.items() if not path.exists() or path.read_text("utf-8") != text]
    if args.check:
        for path in stale:
            print(f"stale: {path} (run scripts/generate_models.py)", file=sys.stderr)
        return 1 if stale else 0
    for path in stale:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(outputs[path], encoding="utf-8")
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
