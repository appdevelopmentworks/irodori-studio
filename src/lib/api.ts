// ALL internal-API (sidecar) calls go through this module. The base URL comes from
// the `sidecar` store, which gets the port from the `get_sidecar_port` Tauri command
// (D10); never write a port literal. Implemented in Session 3.
export {};
