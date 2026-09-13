# Owned state store

Shared, side-effect-free primitives for independent Todo, Notes, and Workplan stores. Each provider creates its own `BranchStateOwner`. Instances do not share a store, lock, lifecycle, or mutable singleton.

The library supplies immutable objects, verified Pi custom anchors, bounded branch resolution, complete source pages, and small durable import-progress pointers. Providers retain their native schema, reducers, transaction serialization, import logic, and complete transfer format.

Read [API.md](API.md) for the interface, persistence boundary, limits, and crash behavior. The library does not register tools or require Chrono.
