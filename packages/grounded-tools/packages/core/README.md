# @grounded/pi-core

Internal shared evidence-preserving primitives used by the modular Grounded Pi tool packages.

Core registers no Pi tools. Grounded Process owns the live session registry and uses Core's versioned provider contract, strict control framing, local non-PTY supervisor, persistent PTY bridge, exact private logs, and lifecycle types. PTY output uses one merged terminal stream. Exact PTY input is accepted only while a structured command is running. Provider IDs and backend ownership must be unique. A missing or failed SSH provider never falls back to the local provider.

The provider contract stays at protocol v1. The original operation service v1 remains for Stage 4 local consumers. Operation service v2 adds one provider-neutral `withSession` callback and an optional file-resource protocol v1 on the captured context. Grounded Files can therefore run local or accepted SSH file operations in the existing session FIFO. The boundary exposes identity, provider metadata, working directory, and the narrow file resource. It does not expose shell handles, environments, provider controls, active-route selection, or implicit session creation. Grounded Process remains the only registry owner.
