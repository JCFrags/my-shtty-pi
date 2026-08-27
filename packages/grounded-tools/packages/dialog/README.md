# @grounded/pi-dialog

This package keeps `ask_user_question` as the direct structured questionnaire tool. It supports descriptions, previews, stable values, free-form answers, TUI/RPC use, and headless deactivation.

It also supplies the strict version-1 `ask_user` facade and the session-local blocking provider. The canonical tool is off by default. Opt in with:

```json
{
  "askUserV1": true
}
```

Store that object in `~/.pi/agent/grounded-dialog.json`. The extension only reads the file. It does not modify settings.

The facade requires explicit `blocking` or `deferred` mode. This package owns no durable question store. It does not implement the deferred provider. See [`../../docs/ask-user-v1.md`](../../docs/ask-user-v1.md) for the frozen provider contract, channel names, schemas, lifecycle, errors, and rollback.
