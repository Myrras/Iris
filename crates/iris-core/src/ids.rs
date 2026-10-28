//! Strongly-typed UUID newtypes.
//!
//! A `uuid_newtype!` macro keeps ids distinct at the type level (you cannot pass
//! one kind of id where another is expected) while serializing transparently
//! as a plain UUID string across the IPC boundary.

// Paths inside are fully qualified so the macro works in any module.
macro_rules! uuid_newtype {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(
            Debug,
            Clone,
            Copy,
            PartialEq,
            Eq,
            Hash,
            ::serde::Serialize,
            ::serde::Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(::uuid::Uuid);

        impl $name {
            /// Generate a fresh random (v4) id.
            pub fn new() -> Self {
                Self(::uuid::Uuid::new_v4())
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl ::std::fmt::Display for $name {
            fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
                self.0.fmt(f)
            }
        }

        impl ::std::str::FromStr for $name {
            type Err = ::uuid::Error;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Ok(Self(<::uuid::Uuid as ::std::str::FromStr>::from_str(s)?))
            }
        }
    };
}

uuid_newtype!(
    /// A saved connection profile (`connection::ConnectionProfile`).
    ProfileId
);

uuid_newtype!(
    /// A live SSH/SFTP session owned by the session manager.
    SessionId
);

uuid_newtype!(
    /// One pending "trust this host key?" prompt, answered through
    /// `Core::answer_host_key`.
    HostKeyRequestId
);

uuid_newtype!(
    /// One file transfer job (`transfer::TransferJob`).
    TransferId
);

uuid_newtype!(
    /// The jobs one `enqueue_transfers` call created.
    BatchId
);

uuid_newtype!(
    /// One remote file opened for editing in a local editor
    /// (`edit::EditInfo`).
    EditId
);

uuid_newtype!(
    /// One drag of remote files out of the window (`drag_out`). Chosen by
    /// the caller, so it can match progress events and cancel before
    /// `prepare_drag_out` returns.
    DragOutId
);

uuid_newtype!(
    /// One folder comparison made by `Core::plan_sync`, run by
    /// `Core::run_sync`.
    SyncPlanId
);

#[cfg(test)]
mod tests {

    uuid_newtype!(
        /// A test-only id, standing in for the real ones.
        SampleId
    );

    #[test]
    fn serializes_as_plain_uuid_string() {
        let id = SampleId::new();
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, format!("\"{id}\""));
    }

    #[test]
    fn round_trips_through_from_str() {
        let id = SampleId::new();
        let parsed: SampleId = id.to_string().parse().unwrap();
        assert_eq!(parsed, id);
    }
}
