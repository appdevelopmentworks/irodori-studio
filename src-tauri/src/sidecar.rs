//! Sidecar lifecycle: free port on 127.0.0.1 (D10), spawn, `/health` polling, status,
//! and a teardown guard that kills the process tree on any exit — Windows Job
//! Object, macOS process group (golden rule 4). Implemented in Session 1.
