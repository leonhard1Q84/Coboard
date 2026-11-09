//! Pure document rules. No filesystem, clock, network, UI or platform dependencies.
mod editor;
mod ink;
mod model;
pub use editor::*;
pub use ink::*;
pub use model::*;
