//! Saved connections: what a profile holds and where profiles are stored.
//!
//! A [`ConnectionProfile`] never carries a secret. Passwords and key
//! passphrases are prompted per connect and handed to
//! [`crate::Core::connect`] as [`crate::Secret`]s, or remembered in the OS
//! keychain ([`crate::secrets`]) — never in the profile.
//!
//! [`route`] turns a profile (plus `~/.ssh/config` and its jump hosts) into
//! the hops a connect walks.

pub mod route;
mod store;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::ids::ProfileId;

pub use store::ProfileStore;

/// The default SSH port.
pub const DEFAULT_PORT: u16 = 22;

/// One saved connection.
///
/// On the wire and on disk:
/// `{ "id", "name", "host", "port", "user", "auth": { "kind": … }, "startDir",
/// "jump" }`.
/// `id` may be omitted when saving a new profile (a fresh one is generated)
/// and `port` defaults to 22.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    #[serde(default)]
    pub id: ProfileId,
    /// Display name; defaults to `user@host` when left blank.
    #[serde(default)]
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
    /// Remote folder to open after connecting; `None` = the login folder.
    #[serde(default)]
    pub start_dir: Option<String>,
    /// Reach the host through this jump host (`ProxyJump`); `None` = connect
    /// directly (or as `~/.ssh/config` says, for an `sshConfigHost`).
    #[serde(default)]
    pub jump: Option<JumpHost>,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

/// How a profile authenticates, tagged by `kind`.
///
/// No variant holds a secret: the password / passphrase is supplied per
/// connect or read from the keychain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AuthMethod {
    /// Password authentication; the password is prompted per connect.
    Password,
    /// Public-key authentication with a private key file on disk. The key is
    /// read at connect time only; an encrypted key needs a passphrase.
    KeyFile { path: String },
    /// Public-key authentication with each identity of the running SSH agent
    /// in turn.
    Agent,
    /// Everything as `~/.ssh/config` says for `alias`, resolved at connect
    /// time: its HostName/User/Port win over the profile's fields, its
    /// IdentityFiles are tried in order and then the agent, and its
    /// ProxyJump applies unless the profile names a jump host.
    SshConfigHost { alias: String },
}

/// The jump host a profile is reached through, tagged by `kind`:
/// `{ "kind": "profile", "profileId" }` (another saved connection, with its
/// own auth and remembered secrets) or `{ "kind": "alias", "alias" }` (a
/// `~/.ssh/config` host or `[user@]host[:port]`, authenticated with its
/// identity files and the agent).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum JumpHost {
    Profile { profile_id: ProfileId },
    Alias { alias: String },
}

/// A non-empty name without whitespace (aliases, jump host specs).
fn single_word(value: String, what: &str) -> CoreResult<String> {
    let value = value.trim().to_string();
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        return Err(CoreError::InvalidInput(format!(
            "{what} must be a non-empty name without spaces"
        )));
    }
    Ok(value)
}

impl ConnectionProfile {
    /// Validate and tidy a profile before it is stored: trims every text
    /// field, turns a blank start folder into `None` and a blank name into
    /// `user@host`.
    pub fn normalized(self) -> CoreResult<Self> {
        let host = self.host.trim().to_string();
        let user = self.user.trim().to_string();
        if host.is_empty() || host.chars().any(char::is_whitespace) {
            return Err(CoreError::InvalidInput(
                "host must be a non-empty name without spaces".into(),
            ));
        }
        if user.is_empty() {
            return Err(CoreError::InvalidInput("user must not be empty".into()));
        }
        if self.port == 0 {
            return Err(CoreError::InvalidInput(
                "port must be between 1 and 65535".into(),
            ));
        }
        let auth = match self.auth {
            AuthMethod::Password => AuthMethod::Password,
            AuthMethod::KeyFile { path } => {
                let path = path.trim().to_string();
                if path.is_empty() {
                    return Err(CoreError::InvalidInput(
                        "key file path must not be empty".into(),
                    ));
                }
                AuthMethod::KeyFile { path }
            }
            AuthMethod::Agent => AuthMethod::Agent,
            AuthMethod::SshConfigHost { alias } => AuthMethod::SshConfigHost {
                alias: single_word(alias, "the SSH config host")?,
            },
        };
        let jump = match self.jump {
            None => None,
            Some(JumpHost::Profile { profile_id }) if profile_id == self.id => {
                return Err(CoreError::InvalidInput(
                    "a connection cannot be its own jump host".into(),
                ))
            }
            Some(JumpHost::Profile { profile_id }) => Some(JumpHost::Profile { profile_id }),
            Some(JumpHost::Alias { alias }) => Some(JumpHost::Alias {
                alias: single_word(alias, "the jump host")?,
            }),
        };
        let name = match self.name.trim() {
            "" => format!("{user}@{host}"),
            name => name.to_string(),
        };
        let start_dir = self
            .start_dir
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty());
        Ok(Self {
            id: self.id,
            name,
            host,
            port: self.port,
            user,
            auth,
            start_dir,
            jump,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ConnectionProfile {
        ConnectionProfile {
            id: ProfileId::new(),
            name: "Example".into(),
            host: "sftp.example.test".into(),
            port: 22,
            user: "demo".into(),
            auth: AuthMethod::Password,
            start_dir: None,
            jump: None,
        }
    }

    /// Every object key in a JSON value, recursively.
    fn keys(value: &serde_json::Value, out: &mut Vec<String>) {
        match value {
            serde_json::Value::Object(map) => {
                for (k, v) in map {
                    out.push(k.to_lowercase());
                    keys(v, out);
                }
            }
            serde_json::Value::Array(items) => items.iter().for_each(|v| keys(v, out)),
            _ => {}
        }
    }

    #[test]
    fn serialized_profiles_have_no_secret_fields() {
        for auth in [
            AuthMethod::Password,
            AuthMethod::KeyFile {
                path: "/home/demo/.ssh/id_ed25519".into(),
            },
            AuthMethod::Agent,
            AuthMethod::SshConfigHost {
                alias: "bastion".into(),
            },
        ] {
            let profile = ConnectionProfile {
                auth,
                jump: Some(JumpHost::Alias {
                    alias: "bastion".into(),
                }),
                ..sample()
            };
            let json = serde_json::to_value(&profile).unwrap();
            let mut all = Vec::new();
            keys(&json, &mut all);
            for key in &all {
                assert!(
                    !["password", "passphrase", "secret", "key", "privatekey"]
                        .contains(&key.as_str()),
                    "secret-looking field {key:?} in {json}"
                );
            }
        }
    }

    #[test]
    fn wire_shape_is_camel_case_and_kind_tagged() {
        let profile = ConnectionProfile {
            start_dir: Some("/srv".into()),
            auth: AuthMethod::KeyFile { path: "/k".into() },
            ..sample()
        };
        let json = serde_json::to_value(&profile).unwrap();
        assert_eq!(json["startDir"], "/srv");
        assert_eq!(json["auth"]["kind"], "keyFile");
        assert_eq!(json["auth"]["path"], "/k");
        let json = serde_json::to_value(sample()).unwrap();
        assert_eq!(json["auth"], serde_json::json!({ "kind": "password" }));
        assert!(json["startDir"].is_null());
        assert!(json["jump"].is_null());

        let jump_id = ProfileId::new();
        let profile = ConnectionProfile {
            auth: AuthMethod::SshConfigHost {
                alias: "web".into(),
            },
            jump: Some(JumpHost::Profile {
                profile_id: jump_id,
            }),
            ..sample()
        };
        let json = serde_json::to_value(&profile).unwrap();
        assert_eq!(
            json["auth"],
            serde_json::json!({ "kind": "sshConfigHost", "alias": "web" })
        );
        assert_eq!(
            json["jump"],
            serde_json::json!({ "kind": "profile", "profileId": jump_id.to_string() })
        );
        let json = serde_json::to_value(ConnectionProfile {
            auth: AuthMethod::Agent,
            jump: Some(JumpHost::Alias {
                alias: "ops@bastion:2222".into(),
            }),
            ..sample()
        })
        .unwrap();
        assert_eq!(json["auth"], serde_json::json!({ "kind": "agent" }));
        assert_eq!(
            json["jump"],
            serde_json::json!({ "kind": "alias", "alias": "ops@bastion:2222" })
        );
    }

    #[test]
    fn phase_one_profiles_without_a_jump_still_load() {
        let profile: ConnectionProfile = serde_json::from_str(
            r#"{"host":"h.example.test","user":"u","auth":{"kind":"keyFile","path":"/k"}}"#,
        )
        .unwrap();
        assert_eq!(profile.jump, None);
    }

    #[test]
    fn id_and_port_are_optional_on_input() {
        let profile: ConnectionProfile = serde_json::from_str(
            r#"{"name":"x","host":"h.example.test","user":"u","auth":{"kind":"password"}}"#,
        )
        .unwrap();
        assert_eq!(profile.port, 22);
        assert_eq!(profile.start_dir, None);
    }

    #[test]
    fn a_stray_password_field_is_dropped() {
        let profile: ConnectionProfile = serde_json::from_str(
            r#"{"host":"h.example.test","user":"u","password":"hunter2","auth":{"kind":"password"}}"#,
        )
        .unwrap();
        let json = serde_json::to_string(&profile).unwrap();
        assert!(!json.contains("hunter2"));
    }

    #[test]
    fn normalized_trims_and_fills_defaults() {
        let profile = ConnectionProfile {
            name: "  ".into(),
            host: " sftp.example.test ".into(),
            user: " demo ".into(),
            start_dir: Some("   ".into()),
            ..sample()
        }
        .normalized()
        .unwrap();
        assert_eq!(profile.name, "demo@sftp.example.test");
        assert_eq!(profile.host, "sftp.example.test");
        assert_eq!(profile.user, "demo");
        assert_eq!(profile.start_dir, None);
    }

    #[test]
    fn a_profile_cannot_jump_through_itself() {
        let profile = sample();
        let looped = ConnectionProfile {
            jump: Some(JumpHost::Profile {
                profile_id: profile.id,
            }),
            ..profile
        };
        assert!(matches!(
            looped.normalized(),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn normalized_trims_aliases() {
        let profile = ConnectionProfile {
            auth: AuthMethod::SshConfigHost {
                alias: " web ".into(),
            },
            jump: Some(JumpHost::Alias {
                alias: " bastion ".into(),
            }),
            ..sample()
        }
        .normalized()
        .unwrap();
        assert_eq!(
            profile.auth,
            AuthMethod::SshConfigHost {
                alias: "web".into()
            }
        );
        assert_eq!(
            profile.jump,
            Some(JumpHost::Alias {
                alias: "bastion".into()
            })
        );
    }

    #[test]
    fn normalized_rejects_bad_input() {
        let bad = [
            ConnectionProfile {
                host: " ".into(),
                ..sample()
            },
            ConnectionProfile {
                host: "two words".into(),
                ..sample()
            },
            ConnectionProfile {
                user: "".into(),
                ..sample()
            },
            ConnectionProfile {
                port: 0,
                ..sample()
            },
            ConnectionProfile {
                auth: AuthMethod::KeyFile { path: " ".into() },
                ..sample()
            },
            ConnectionProfile {
                auth: AuthMethod::SshConfigHost { alias: " ".into() },
                ..sample()
            },
            ConnectionProfile {
                jump: Some(JumpHost::Alias {
                    alias: "two words".into(),
                }),
                ..sample()
            },
        ];
        for profile in bad {
            assert!(matches!(
                profile.normalized(),
                Err(CoreError::InvalidInput(_))
            ));
        }
    }
}
