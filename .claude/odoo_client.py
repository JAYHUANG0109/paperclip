#!/usr/bin/env python3
"""Odoo XML-RPC client for Paperclip agents (stdlib only).

Per-user auth model (mirrors asana_client.py):
  - The agent's OWN Odoo login + API key are read from the JSON file pointed to
    by the env var ODOO_CONNECTION_PATH, else `.claude/odoo-connection.json` in
    the workspace, else `~/.claude/odoo-connection.json`. Shape:
        {
          "login": "someone@seasonart.org",
          "connectTimeoutSeconds": 6,
          "connections": [
            { "name": "user-eip", "url": "https://eip.seasonarts.ltd",
              "db": "eip", "apiKey": "…", "note": "User's OWN Odoo key (read-only)." },
            { "name": "fallback",  "url": "https://seasonart-test.aiuptop.com",
              "db": "eip", "apiKey": "…" }
          ]
        }
  - The API key acts AS that Odoo user, so Odoo enforces their real permissions.
  - Connections are tried IN ORDER: the first that authenticates wins ("主站→備援"
    auto-switch). The official site is https://eip.seasonarts.ltd;
    https://seasonart-test.aiuptop.com is the 備援. That official host serves TWO
    databases — `eip` (production) and `test-eip` (staging) — and a given user's
    key authenticates on exactly one of them, so `db` is per-user, never assumed.
    The server picks it with a live auth probe when it writes this file
    (server/src/services/agent-odoo.ts).
  - The API key comes from the env var ODOO_API_KEY when set (the responsible
    user's UI-managed "My secrets" value, injected into every run) and otherwise
    from the connection file. With ODOO_API_KEY plus ODOO_LOGIN/ODOO_URL/ODOO_DB
    set, no connection file is needed at all.
  - NEVER hardcode a key here and NEVER use someone else's key. Keys are masked
    (last 4 chars) in every message this script prints.

Importable API (what AGENTS.md documents):
    from odoo_client import connect
    odoo = connect()                       # does the main→fallback auto-switch
    odoo.search_read("hr.employee", [], fields=["name"], limit=5)
    odoo.count("hr.employee", [])
    odoo.search("hr.employee", [], limit=5)
    odoo.execute("hr.employee", "read", [744], {"fields": ["name"]})

CLI (output is always JSON on stdout; errors go to stderr with non-zero exit):
    python3 .claude/odoo_client.py whoami
    python3 .claude/odoo_client.py search_read hr.employee '[["active","=",true]]' --fields name,work_email --limit 10
    python3 .claude/odoo_client.py search       hr.employee '[]' --limit 10
    python3 .claude/odoo_client.py count        hr.employee '[]'
    python3 .claude/odoo_client.py read         hr.employee '[744]' --fields name,work_email
    python3 .claude/odoo_client.py name-search  hr.employee --name "Betty" --limit 10
    python3 .claude/odoo_client.py fields       hr.employee
    python3 .claude/odoo_client.py execute      hr.employee search_count '[[]]'

Writes (create/write/unlink/…) are REFUSED by default. Enable only when the
connection file has "readOnly": false, or pass --allow-writes.
"""
import json
import os
import ssl
import sys
import xmlrpc.client

DEFAULT_CONNECT_TIMEOUT = 6
DATA_TIMEOUT = 45  # reads (search_read etc.) can be slower than the auth probe

# Methods that only read. `execute` refuses everything else unless writes are
# explicitly enabled — the key is meant to be read-only.
READ_METHODS = {
    "search", "search_read", "search_count", "read", "fields_get",
    "name_search", "name_get", "default_get", "read_group", "get",
    "check_access_rights", "web_search_read", "web_read", "load_views",
    "fields_view_get", "read_progress_bar",
}


def _fail(msg, code=1):
    sys.stderr.write(f"odoo_client: {msg}\n")
    sys.exit(code)


def _mask(secret):
    s = (secret or "")
    return (s[:3] + "…" + s[-4:]) if len(s) >= 8 else "…"


class _TimeoutTransport(xmlrpc.client.SafeTransport):
    """SafeTransport that applies a socket timeout (stdlib ServerProxy has no
    timeout kwarg). All Odoo endpoints here are https, so SafeTransport is fine."""

    def __init__(self, timeout, context=None):
        super().__init__(context=context)
        self._timeout = timeout

    def make_connection(self, host):
        conn = super().make_connection(host)
        conn.timeout = self._timeout
        return conn


def _proxy(url, endpoint, timeout, context):
    base = url.rstrip("/")
    return xmlrpc.client.ServerProxy(
        f"{base}/xmlrpc/2/{endpoint}",
        transport=_TimeoutTransport(timeout, context=context),
        allow_none=True,
    )


def _resolve_config_path(explicit=None):
    if explicit:
        return explicit
    env = os.environ.get("ODOO_CONNECTION_PATH")
    if env:
        return env
    for cand in (
        os.path.join(os.getcwd(), ".claude", "odoo-connection.json"),
        os.path.expanduser("~/.claude/odoo-connection.json"),
    ):
        if os.path.exists(cand):
            return cand
    # Paperclip injects PAPERCLIP_COMPANY_ID + PAPERCLIP_AGENT_ID into every run.
    # The per-agent connection file lives under the instance dir; resolve it from
    # those so no ODOO_CONNECTION_PATH wiring is needed (mirrors how Asana's
    # ASANA_TOKEN_PATH points at the same per-agent directory).
    company = (os.environ.get("PAPERCLIP_COMPANY_ID") or "").strip()
    agent = (os.environ.get("PAPERCLIP_AGENT_ID") or "").strip()
    if company and agent:
        import glob
        base = os.path.expanduser("~/.paperclip/instances")
        for inst in ([os.path.join(base, "default")] + sorted(glob.glob(os.path.join(base, "*")))):
            cand = os.path.join(inst, "companies", company, "agents", agent, "odoo-connection.json")
            if os.path.exists(cand):
                return cand
    return None


def _config_from_env():
    """A run env alone is enough when the server injected ODOO_API_KEY (the user's
    "My secrets" value) plus the login/target it stored. Returns None if not."""
    key = (os.environ.get("ODOO_API_KEY") or "").strip()
    login = (os.environ.get("ODOO_LOGIN") or "").strip()
    if not key or not login:
        return None
    url = (os.environ.get("ODOO_URL") or "https://eip.seasonarts.ltd").strip()
    db = (os.environ.get("ODOO_DB") or "").strip()
    if not db:
        return None
    return {
        "login": login,
        "readOnly": (os.environ.get("ODOO_ALLOW_WRITES") or "").strip().lower() not in ("1", "true", "yes"),
        "connections": [{"name": "env", "url": url, "db": db, "apiKey": key}],
    }


def _load_config(explicit=None):
    path = _resolve_config_path(explicit)
    if not path:
        env_cfg = _config_from_env()
        if env_cfg:
            return env_cfg, env_cfg["login"], env_cfg["connections"], "<env>"
        _fail("no Odoo connection file. Set ODOO_CONNECTION_PATH, or place "
              ".claude/odoo-connection.json in the workspace. Ask the user for "
              "their Odoo login + API key; do not proceed without it.", 3)
    if not os.path.exists(path):
        _fail(f"connection file not found at {path}", 3)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        _fail(f"could not read connection file: {exc}", 3)
    login = (cfg.get("login") or "").strip()
    conns = cfg.get("connections") or []
    if not login:
        _fail("connection file has no 'login'.", 3)
    if not conns:
        _fail("connection file has no 'connections'.", 3)
    return cfg, login, conns, path


class Odoo:
    """A live, authenticated connection to one Odoo backend."""

    def __init__(self, url, db, login, uid, key, name, read_only, context, timeout):
        self.url = url
        self.db = db
        self.login = login
        self.uid = uid
        self.name = name
        self.read_only = read_only
        self._key = key
        self._context = context
        self._timeout = timeout
        self._models = _proxy(url, "object", timeout, context)

    def execute(self, model, method, *args, **kwargs):
        if self.read_only and method not in READ_METHODS:
            raise PermissionError(
                f"'{method}' on {model} is a write op but this connection is "
                f"read-only (set readOnly:false or pass --allow-writes)."
            )
        # execute_kw takes positional args as a list and kwargs as a dict.
        pos = list(args)
        return self._models.execute_kw(self.db, self.uid, self._key, model, method, pos, kwargs or {})

    def search(self, model, domain=None, **kwargs):
        return self.execute(model, "search", domain or [], **kwargs)

    def search_read(self, model, domain=None, fields=None, **kwargs):
        if fields is not None:
            kwargs["fields"] = fields
        return self.execute(model, "search_read", domain or [], **kwargs)

    def count(self, model, domain=None):
        return self.execute(model, "search_count", domain or [])

    def read(self, model, ids, fields=None):
        kwargs = {"fields": fields} if fields is not None else {}
        return self.execute(model, "read", ids, **kwargs)


def connect(config_path=None, allow_writes=False):
    """Authenticate against the configured connections in order; return an Odoo
    bound to the first that succeeds (主站→備援 auto-switch). Raises on total
    failure with masked diagnostics."""
    cfg, login, conns, _path = _load_config(config_path)
    connect_timeout = int(cfg.get("connectTimeoutSeconds") or DEFAULT_CONNECT_TIMEOUT)
    file_read_only = bool(cfg.get("readOnly", True))  # default read-only
    read_only = file_read_only and not allow_writes
    context = ssl.create_default_context()
    # Key precedence: the run env (the user's UI-managed "My secrets" value, so a
    # rotation there wins over a stale file), then the file's top-level key, then
    # any non-empty per-connection key so one key covers all connections.
    env_key = (os.environ.get("ODOO_API_KEY") or "").strip()
    any_key = env_key or (cfg.get("apiKey") or "").strip() or next(
        (c.get("apiKey").strip() for c in conns if (c.get("apiKey") or "").strip()), ""
    )
    errors = []
    for c in conns:
        url = (c.get("url") or "").strip()
        db = (c.get("db") or "").strip()
        key = env_key or (c.get("apiKey") or "").strip() or any_key
        label = c.get("name") or url
        if not url or not db:
            errors.append(f"{label}: missing url/db"); continue
        if not key:
            errors.append(f"{label}: no API key yet — ask the user for their Odoo key"); continue
        try:
            common = _proxy(url, "common", connect_timeout, context)
            uid = common.authenticate(db, login, key, {})
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{label} ({url} db={db}): {type(exc).__name__}: {str(exc)[:120]}")
            continue
        if not uid:
            errors.append(f"{label} ({url} db={db}): auth failed for {login} (key {_mask(key)})")
            continue
        # Resolve a friendly name (best-effort; never fatal).
        name = login
        try:
            models = _proxy(url, "object", DATA_TIMEOUT, context)
            recs = models.execute_kw(db, uid, key, "res.users", "read", [[uid]], {"fields": ["name"]})
            if recs:
                name = recs[0].get("name") or login
        except Exception:  # noqa: BLE001
            pass
        return Odoo(url, db, login, uid, key, name, read_only, context, DATA_TIMEOUT)
    raise ConnectionError(
        "could not authenticate to any Odoo connection for "
        f"{login}:\n  - " + "\n  - ".join(errors)
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _opt(args, name, default=None):
    flag = f"--{name}"
    if flag in args:
        i = args.index(flag)
        if i + 1 < len(args):
            return args[i + 1]
    return default


def _positional(args):
    """Positional args are everything before the first --flag."""
    out = []
    for a in args:
        if a.startswith("--"):
            break
        out.append(a)
    return out


def _json_arg(s, what):
    try:
        return json.loads(s)
    except Exception as exc:  # noqa: BLE001
        _fail(f"could not parse {what} as JSON: {exc}", 2)


def _fields_arg(args):
    f = _opt(args, "fields")
    return [x.strip() for x in f.split(",") if x.strip()] if f else None


def _int_opt(args, name):
    v = _opt(args, name)
    if v is None:
        return None
    try:
        return int(v)
    except ValueError:
        _fail(f"--{name} must be an integer.", 2)


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help", "help"):
        sys.stdout.write(__doc__)
        sys.exit(0 if argv else 2)
    cmd = argv[0]
    args = argv[1:]

    allow_writes = "--allow-writes" in args
    config_path = _opt(args, "connection")
    try:
        odoo = connect(config_path=config_path, allow_writes=allow_writes)
    except (ConnectionError, PermissionError) as exc:
        _fail(str(exc), 5)

    pos = _positional(args)
    fields = _fields_arg(args)
    limit = _int_opt(args, "limit")
    offset = _int_opt(args, "offset")
    order = _opt(args, "order")

    def read_kwargs():
        k = {}
        if limit is not None:
            k["limit"] = limit
        if offset is not None:
            k["offset"] = offset
        if order:
            k["order"] = order
        return k

    try:
        if cmd == "whoami":
            out = {"login": odoo.login, "name": odoo.name, "uid": odoo.uid,
                   "url": odoo.url, "db": odoo.db, "readOnly": odoo.read_only}
        elif cmd in ("search", "search_read", "count", "read", "name-search", "fields", "execute"):
            if not pos:
                _fail(f"'{cmd}' needs a model, e.g. hr.employee.", 2)
            model = pos[0]
            if cmd == "search":
                domain = _json_arg(pos[1], "domain") if len(pos) > 1 else []
                out = odoo.search(model, domain, **read_kwargs())
            elif cmd == "search_read":
                domain = _json_arg(pos[1], "domain") if len(pos) > 1 else []
                out = odoo.search_read(model, domain, fields=fields, **read_kwargs())
            elif cmd == "count":
                domain = _json_arg(pos[1], "domain") if len(pos) > 1 else []
                out = odoo.count(model, domain)
            elif cmd == "read":
                if len(pos) < 2:
                    _fail("read needs ids JSON, e.g. read hr.employee '[744]'.", 2)
                ids = _json_arg(pos[1], "ids")
                out = odoo.read(model, ids, fields=fields)
            elif cmd == "name-search":
                name = _opt(args, "name") or ""
                k = {"name": name}
                if limit is not None:
                    k["limit"] = limit
                out = odoo.execute(model, "name_search", **k)
            elif cmd == "fields":
                attrs = _fields_arg(args) or ["string", "type", "help", "required", "readonly", "relation"]
                out = odoo.execute(model, "fields_get", **{"attributes": attrs})
            elif cmd == "execute":
                if len(pos) < 2:
                    _fail("execute needs a method, e.g. execute hr.employee search_count '[[]]'.", 2)
                method = pos[1]
                m_args = _json_arg(pos[2], "args") if len(pos) > 2 else []
                m_kwargs = _json_arg(pos[3], "kwargs") if len(pos) > 3 else {}
                if not isinstance(m_args, list):
                    _fail("execute args must be a JSON list.", 2)
                out = odoo.execute(model, method, *m_args, **m_kwargs)
        else:
            _fail(f"unknown command '{cmd}'. Run with --help.", 2)
    except PermissionError as exc:
        _fail(str(exc), 6)
    except xmlrpc.client.Fault as exc:
        _fail(f"Odoo fault: {exc.faultString.splitlines()[-1][:200]}", 4)
    except Exception as exc:  # noqa: BLE001
        _fail(f"{type(exc).__name__}: {str(exc)[:200]}", 5)

    json.dump(out, sys.stdout, ensure_ascii=False, indent=2, default=str)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
