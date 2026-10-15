//! Strongly-typed UUID newtypes.
//!
//! A `uuid_newtype!` macro keeps ids distinct at the type level (you cannot pass
//! one kind of id where another is expected) while serializing transparently
//! as a plain UUID string across the IPC boundary.
//!
//! Phase 0 has no domain entities yet; the first ids (saved connections)
//! arrive in Phase 1 and are declared here with the macro.

// Unused until Phase 1 declares the first id; the tests below exercise it.
// Paths inside are fully qualified so the module needs no imports of its own
// while no id exists yet.
#[allow(unused_macros)]
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
