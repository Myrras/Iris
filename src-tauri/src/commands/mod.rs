//! IPC command modules. Each command is a thin (de)serialization shim over
//! [`iris_core::Core`]; no domain logic lives here.

pub mod connection;
pub mod fs;
pub mod session;
pub mod settings;
pub mod window;
