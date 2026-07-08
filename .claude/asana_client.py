#!/usr/bin/env python3
"""Asana REST API client for Paperclip agents (stdlib only).

Per-user auth model (mirrors odoo_client.py):
  - The agent's OWN Asana Personal Access Token is read from the JSON file
    pointed to by the env var ASANA_TOKEN_PATH, e.g.:
        { "token": "1/12345:abcdef...", "readOnly": false,
          "defaultWorkspace": "1199...", "note": "User's OWN Asana PAT" }
  - The token acts AS that Asana user, so Asana enforces their real permissions.
  - NEVER hardcode a token here and NEVER use someone else's token.

Usage:
  python3 .claude/asana_client.py whoami
  python3 .claude/asana_client.py workspaces
  python3 .claude/asana_client.py projects [--workspace GID]
  python3 .claude/asana_client.py project-tasks --project GID [--completed-since now]
  python3 .claude/asana_client.py search --workspace GID --text "keyword"
  python3 .claude/asana_client.py get-task --task GID
  python3 .claude/asana_client.py create-task --project GID --name "..." [--notes "..."] [--assignee me|GID] [--due 2026-06-30]
  python3 .claude/asana_client.py update-task --task GID [--name ..] [--notes ..] [--due ..] [--completed true|false]
  python3 .claude/asana_client.py complete-task --task GID
  python3 .claude/asana_client.py comment --task GID --text "..."
  python3 .claude/asana_client.py stories --task GID   # task comments/activity (newest last)

Output is always JSON on stdout. Errors go to stderr with a non-zero exit.
Write operations (create/update/complete/comment) are refused if readOnly is true.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API_BASE = "https://app.asana.com/api/1.0"
TIMEOUT = 20

WRITE_COMMANDS = {"create-task", "update-task", "complete-task", "comment"}


def _fail(msg, code=1):
    sys.stderr.write(f"asana_client: {msg}\n")
    sys.exit(code)


def _load_config():
    # Preferred: the token injected into the run env from the responsible user's
    # per-user secret ("My secrets", key ASANA_TOKEN) — the single, UI-managed
    # source of truth.
    env_token = (os.environ.get("ASANA_ACCESS_TOKEN") or "").strip()
    if env_token:
        return {"token": env_token}, env_token
    # Fallback: the legacy per-agent connection file (ASANA_TOKEN_PATH).
    path = os.environ.get("ASANA_TOKEN_PATH")
    if not path:
        _fail("No ASANA_ACCESS_TOKEN in env and ASANA_TOKEN_PATH is not set. Ask "
              "the user to set their Asana Personal Access Token under My secrets "
              "(or hand it to their agent); do not proceed without it.", 3)
    if not os.path.exists(path):
        _fail(f"token file not found at {path}", 3)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        _fail(f"could not read token file: {exc}", 3)
    token = (cfg.get("token") or "").strip()
    if not token:
        _fail("no Asana token yet. Ask the user to generate a Personal Access "
              "Token at https://app.asana.com/0/my-apps and set it under My "
              "secrets. Refuse Asana actions until provided.", 3)
    return cfg, token


def _request(method, path, token, query=None, body=None):
    url = f"{API_BASE}{path}"
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = None
    if body is not None:
        data = json.dumps({"data": body}).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            payload = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        _fail(f"HTTP {exc.code} on {method} {path}: {detail}", 4)
    except urllib.error.URLError as exc:
        _fail(f"network error on {method} {path}: {exc.reason}", 5)
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return {"raw": payload}


def _opt(args, name, default=None):
    flag = f"--{name}"
    if flag in args:
        i = args.index(flag)
        if i + 1 < len(args):
            return args[i + 1]
    return default


def main():
    argv = sys.argv[1:]
    if not argv:
        _fail("no command. See header of this file for usage.", 2)
    cmd = argv[0]
    args = argv[1:]

    cfg, token = _load_config()
    if cmd in WRITE_COMMANDS and cfg.get("readOnly"):
        _fail(f"'{cmd}' is a write op but this token is configured readOnly.", 6)

    default_ws = cfg.get("defaultWorkspace")

    if cmd == "whoami":
        out = _request("GET", "/users/me", token,
                       query={"opt_fields": "name,email,workspaces.name"})
    elif cmd == "workspaces":
        out = _request("GET", "/workspaces", token, query={"opt_fields": "name"})
    elif cmd == "projects":
        ws = _opt(args, "workspace", default_ws)
        if not ws:
            _fail("--workspace GID required (or set defaultWorkspace).", 2)
        out = _request("GET", "/projects", token,
                       query={"workspace": ws, "opt_fields": "name,archived",
                              "limit": "100"})
    elif cmd == "project-tasks":
        proj = _opt(args, "project")
        if not proj:
            _fail("--project GID required.", 2)
        q = {"opt_fields": "name,completed,assignee.name,due_on,notes",
             "limit": "100"}
        cs = _opt(args, "completed-since")
        if cs:
            q["completed_since"] = cs
        out = _request("GET", f"/projects/{proj}/tasks", token, query=q)
    elif cmd == "project-sections":
        proj = _opt(args, "project")
        if not proj:
            _fail("--project GID required.", 2)
        out = _request("GET", f"/projects/{proj}/sections", token,
                       query={"opt_fields": "name", "limit": "100"})
    elif cmd == "section-tasks":
        section = _opt(args, "section")
        if not section:
            _fail("--section GID required.", 2)
        q = {"opt_fields": "name,completed,assignee.name,due_on,due_at,permalink_url,notes",
             "limit": "100"}
        cs = _opt(args, "completed-since")
        if cs:
            q["completed_since"] = cs
        out = _request("GET", f"/sections/{section}/tasks", token, query=q)
    elif cmd == "search":
        ws = _opt(args, "workspace", default_ws)
        text = _opt(args, "text")
        if not ws or not text:
            _fail("--workspace GID and --text required.", 2)
        out = _request("GET", f"/workspaces/{ws}/tasks/search", token,
                       query={"text": text,
                              "opt_fields": "name,completed,assignee.name,due_on"})
    elif cmd == "my-tasks":
        # The caller's own "My Tasks" list for a workspace — i.e. tasks assigned
        # to me. Use --completed-since now to get only incomplete tasks.
        ws = _opt(args, "workspace", default_ws)
        if not ws:
            _fail("--workspace GID required (or set defaultWorkspace).", 2)
        utl = _request("GET", "/users/me/user_task_list", token,
                       query={"workspace": ws, "opt_fields": "gid"})
        list_gid = (utl.get("data") or {}).get("gid")
        if not list_gid:
            _fail("could not resolve user task list for this workspace.", 5)
        q = {"opt_fields": "name,completed,due_on,due_at,permalink_url,projects.name,notes",
             "limit": "100"}
        cs = _opt(args, "completed-since")
        if cs:
            q["completed_since"] = cs
        out = _request("GET", f"/user_task_lists/{list_gid}/tasks", token, query=q)
    elif cmd == "get-task":
        task = _opt(args, "task")
        if not task:
            _fail("--task GID required.", 2)
        out = _request("GET", f"/tasks/{task}", token,
                       query={"opt_fields": "name,notes,completed,assignee.name,"
                              "due_on,projects.name,parent.name,tags.name"})
    elif cmd == "create-task":
        body = {}
        name = _opt(args, "name")
        if not name:
            _fail("--name required.", 2)
        body["name"] = name
        proj = _opt(args, "project")
        ws = _opt(args, "workspace", default_ws)
        if proj:
            body["projects"] = [proj]
        elif ws:
            body["workspace"] = ws
        else:
            _fail("--project GID or --workspace GID required.", 2)
        notes = _opt(args, "notes")
        if notes:
            body["notes"] = notes
        assignee = _opt(args, "assignee")
        if assignee:
            body["assignee"] = assignee
        due = _opt(args, "due")
        if due:
            body["due_on"] = due
        out = _request("POST", "/tasks", token, body=body)
    elif cmd == "update-task":
        task = _opt(args, "task")
        if not task:
            _fail("--task GID required.", 2)
        body = {}
        for f in ("name", "notes", "due"):
            v = _opt(args, f)
            if v is not None:
                body["due_on" if f == "due" else f] = v
        completed = _opt(args, "completed")
        if completed is not None:
            body["completed"] = completed.lower() == "true"
        if not body:
            _fail("nothing to update.", 2)
        out = _request("PUT", f"/tasks/{task}", token, body=body)
    elif cmd == "complete-task":
        task = _opt(args, "task")
        if not task:
            _fail("--task GID required.", 2)
        out = _request("PUT", f"/tasks/{task}", token, body={"completed": True})
    elif cmd == "comment":
        task = _opt(args, "task")
        text = _opt(args, "text")
        if not task or not text:
            _fail("--task GID and --text required.", 2)
        out = _request("POST", f"/tasks/{task}/stories", token,
                       body={"text": text})
    elif cmd == "stories":
        # Task comment thread + activity (oldest→newest). Filter
        # resource_subtype == "comment_added" for human/agent comments; map each to
        # the founder-digest `comments` shape {id, author, text, createdAt}.
        task = _opt(args, "task")
        if not task:
            _fail("--task GID required.", 2)
        out = _request("GET", f"/tasks/{task}/stories", token,
                       query={"opt_fields": "type,resource_subtype,text,created_at,created_by.name",
                              "limit": "100"})
    else:
        _fail(f"unknown command '{cmd}'.", 2)

    json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
