# @grounded/pi-files

Full-fidelity `read`, strict atomic `edit`/`write`, deterministic `grep`/`find`, and explicit `fuzzy_find` for Pi. See the `pi-grounded-tools` repository README for schemas, artifacts, trial mode, and requirements.

This package registers the versioned `pi-grounded-tools/files-v1` Review UI preview adapter. The adapter is bound to this exact extension source path. Edit and write previews use the same pure content-construction functions as execution. Proposed BOM, CRLF, digest, anchored edit, and strict replacement bytes are exact. Review UI must fail closed if a different tool owner is active.
