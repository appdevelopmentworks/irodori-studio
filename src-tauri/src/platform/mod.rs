//! Platform probe run before torch exists; maps hardware to device + precision
//! (D7–D9). Platform-specific code lives only in these modules (golden rule 11).
//! Implemented in Session 1.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;
