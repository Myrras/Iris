//! Turn a saved profile into the hops a connect walks: its jump hosts first
//! (outermost first), the target last.
//!
//! - A profile's own `jump` wins; otherwise an `sshConfigHost` profile uses
//!   the alias's `ProxyJump`.
//! - A `profile` jump is that saved connection's whole route (so jump hosts
//!   chain); an `alias` jump is a `~/.ssh/config` name or
//!   `[user@]host[:port]`, with its own `ProxyJump` applied.
//! - A `ProxyJump a,b` list is walked like OpenSSH: `a` (with its own
//!   config jumps), then `b` through it.
//!
//! Loops and absurdly long chains are refused. Nothing here touches the
//! network or the keychain.

use std::collections::HashSet;

use crate::connection::{AuthMethod, ConnectionProfile, JumpHost};
use crate::error::{CoreError, CoreResult};
use crate::ids::ProfileId;
use crate::ssh_config::{local_user, split_jump_list, JumpSpec, SshConfigFile};

/// At most this many hops (jump hosts + target) per connect.
pub const MAX_HOPS: usize = 8;

/// One SSH login on the way to the target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hop {
    /// How the user knows this hop (profile name, alias or spec), for
    /// error messages.
    pub label: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: HopAuth,
    /// The saved connection whose remembered secrets this hop uses.
    pub profile_id: Option<ProfileId>,
}

/// How one hop logs in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HopAuth {
    Password,
    KeyFile {
        path: String,
    },
    Agent,
    /// Each identity file in turn (missing ones skipped), then the agent.
    Identities {
        files: Vec<String>,
    },
}

/// Lazily loads the SSH config the first time a hop needs it.
pub struct Resolver<'a> {
    profiles: &'a dyn Fn(ProfileId) -> CoreResult<ConnectionProfile>,
    load_config: &'a dyn Fn() -> CoreResult<SshConfigFile>,
    config: Option<SshConfigFile>,
    visited: HashSet<String>,
    hops: usize,
}

impl<'a> Resolver<'a> {
    pub fn new(
        profiles: &'a dyn Fn(ProfileId) -> CoreResult<ConnectionProfile>,
        load_config: &'a dyn Fn() -> CoreResult<SshConfigFile>,
    ) -> Self {
        Self {
            profiles,
            load_config,
            config: None,
            visited: HashSet::new(),
            hops: 0,
        }
    }

    /// The hops for `profile`, target last.
    pub fn route(mut self, profile: &ConnectionProfile) -> CoreResult<Vec<Hop>> {
        self.profile_route(profile)
    }

    fn config(&mut self) -> CoreResult<&SshConfigFile> {
        if self.config.is_none() {
            self.config = Some((self.load_config)()?);
        }
        Ok(self.config.as_ref().expect("just loaded"))
    }

    /// Count a hop and refuse loops (`key` identifies the hop).
    fn enter(&mut self, key: String) -> CoreResult<()> {
        if !self.visited.insert(key) {
            return Err(CoreError::InvalidInput("the jump hosts form a loop".into()));
        }
        self.hops += 1;
        if self.hops > MAX_HOPS {
            return Err(CoreError::InvalidInput(format!(
                "more than {} jump hosts",
                MAX_HOPS - 1
            )));
        }
        Ok(())
    }

    fn profile_route(&mut self, profile: &ConnectionProfile) -> CoreResult<Vec<Hop>> {
        self.enter(format!("profile:{}", profile.id))?;
        let (hop, config_jumps) = match &profile.auth {
            AuthMethod::SshConfigHost { alias } => {
                let resolved = self.config()?.resolve(alias);
                let hop = Hop {
                    label: profile.name.clone(),
                    host: resolved.effective_host().to_string(),
                    port: resolved.port.unwrap_or(profile.port),
                    user: resolved
                        .user
                        .clone()
                        .unwrap_or_else(|| profile.user.clone()),
                    auth: HopAuth::Identities {
                        files: resolved.identity_files.clone(),
                    },
                    profile_id: Some(profile.id),
                };
                (hop, resolved.proxy_jumps())
            }
            auth => {
                let auth = match auth {
                    AuthMethod::Password => HopAuth::Password,
                    AuthMethod::KeyFile { path } => HopAuth::KeyFile { path: path.clone() },
                    AuthMethod::Agent => HopAuth::Agent,
                    AuthMethod::SshConfigHost { .. } => unreachable!("matched above"),
                };
                let hop = Hop {
                    label: profile.name.clone(),
                    host: profile.host.clone(),
                    port: profile.port,
                    user: profile.user.clone(),
                    auth,
                    profile_id: Some(profile.id),
                };
                (hop, Vec::new())
            }
        };
        let mut route = match &profile.jump {
            Some(JumpHost::Profile { profile_id }) => {
                let jump = (self.profiles)(*profile_id).map_err(|_| {
                    CoreError::InvalidInput(format!(
                        "the jump host of {} is a connection that no longer exists",
                        profile.name
                    ))
                })?;
                self.profile_route(&jump)?
            }
            Some(JumpHost::Alias { alias }) => self.spec_route(alias, true)?,
            None => self.jump_list_route(&config_jumps)?,
        };
        route.push(hop);
        Ok(route)
    }

    /// A `ProxyJump a,b,…` list: `a` with its own config jumps, then each
    /// next entry through the previous one.
    fn jump_list_route(&mut self, list: &[String]) -> CoreResult<Vec<Hop>> {
        let mut route = Vec::new();
        for (i, spec) in list.iter().enumerate() {
            route.extend(self.spec_route(spec, i == 0)?);
        }
        Ok(route)
    }

    /// One jump host named by a spec (a config alias or
    /// `[user@]host[:port]`), preceded by its own config `ProxyJump` when
    /// `with_own_jumps`.
    fn spec_route(&mut self, spec: &str, with_own_jumps: bool) -> CoreResult<Vec<Hop>> {
        let parsed = JumpSpec::parse(spec)?;
        self.enter(format!("alias:{}", parsed.host.to_ascii_lowercase()))?;
        let resolved = self.config()?.resolve(&parsed.host);
        let hop = Hop {
            label: spec.to_string(),
            host: resolved.effective_host().to_string(),
            port: parsed
                .port
                .or(resolved.port)
                .unwrap_or(crate::connection::DEFAULT_PORT),
            user: parsed
                .user
                .or_else(|| resolved.user.clone())
                .unwrap_or_else(local_user),
            auth: HopAuth::Identities {
                files: resolved.identity_files.clone(),
            },
            profile_id: None,
        };
        let mut route = if with_own_jumps {
            let own: Vec<String> = split_jump_list(resolved.proxy_jump.as_deref().unwrap_or(""));
            self.jump_list_route(&own)?
        } else {
            Vec::new()
        };
        route.push(hop);
        Ok(route)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    const CONFIG: &str = "\
Host bastion
    HostName bastion.example.test
    User jumper
    Port 2200
    IdentityFile /keys/bastion
Host inner
    HostName inner.example.test
    ProxyJump bastion
Host web
    HostName web.internal.example.test
    User deploy
    IdentityFile /keys/web
    ProxyJump inner
Host direct
    User someone
Host loop-a
    ProxyJump loop-b
Host loop-b
    ProxyJump loop-a
";

    fn profile(name: &str, auth: AuthMethod, jump: Option<JumpHost>) -> ConnectionProfile {
        ConnectionProfile {
            id: ProfileId::new(),
            name: name.into(),
            host: format!("{name}.example.test"),
            port: 22,
            user: "demo".into(),
            auth,
            start_dir: None,
            jump,
            favorites: Vec::new(),
        }
    }

    fn route_of(target: &ConnectionProfile, others: &[ConnectionProfile]) -> CoreResult<Vec<Hop>> {
        let map: HashMap<ProfileId, ConnectionProfile> =
            others.iter().map(|p| (p.id, p.clone())).collect();
        let lookup = move |id: ProfileId| {
            map.get(&id)
                .cloned()
                .ok_or_else(|| CoreError::NotFound("connection".into()))
        };
        let load = || SshConfigFile::parse(CONFIG);
        Resolver::new(&lookup, &load).route(target)
    }

    fn hosts(route: &[Hop]) -> Vec<(String, u16, String)> {
        route
            .iter()
            .map(|h| (h.host.clone(), h.port, h.user.clone()))
            .collect()
    }

    #[test]
    fn a_plain_profile_is_one_hop() {
        let p = profile("alpha", AuthMethod::Password, None);
        let route = route_of(&p, &[]).unwrap();
        assert_eq!(
            route,
            [Hop {
                label: "alpha".into(),
                host: "alpha.example.test".into(),
                port: 22,
                user: "demo".into(),
                auth: HopAuth::Password,
                profile_id: Some(p.id),
            }]
        );
    }

    #[test]
    fn a_config_host_follows_its_proxy_jump_chain() {
        let p = profile(
            "web",
            AuthMethod::SshConfigHost {
                alias: "web".into(),
            },
            None,
        );
        let route = route_of(&p, &[]).unwrap();
        assert_eq!(
            hosts(&route),
            [
                ("bastion.example.test".into(), 2200, "jumper".into()),
                ("inner.example.test".into(), 22, local_user()),
                ("web.internal.example.test".into(), 22, "deploy".into()),
            ]
        );
        assert_eq!(
            route[0].auth,
            HopAuth::Identities {
                files: vec!["/keys/bastion".into()]
            }
        );
        assert_eq!(route[2].profile_id, Some(p.id));
        assert_eq!(route[0].profile_id, None);
    }

    #[test]
    fn profile_fields_fill_what_the_config_leaves_open() {
        let mut p = profile(
            "direct",
            AuthMethod::SshConfigHost {
                alias: "direct".into(),
            },
            None,
        );
        p.port = 2022;
        let route = route_of(&p, &[]).unwrap();
        // No HostName: the alias is the host; config User wins; no Port in
        // the config: the profile's.
        assert_eq!(hosts(&route), [("direct".into(), 2022, "someone".into())]);
        assert_eq!(route[0].auth, HopAuth::Identities { files: vec![] });
    }

    #[test]
    fn the_profile_jump_overrides_the_config_one() {
        let p = profile(
            "web",
            AuthMethod::SshConfigHost {
                alias: "web".into(),
            },
            Some(JumpHost::Alias {
                alias: "ops@gate.example.test:2222".into(),
            }),
        );
        let route = route_of(&p, &[]).unwrap();
        assert_eq!(
            hosts(&route),
            [
                ("gate.example.test".into(), 2222, "ops".into()),
                ("web.internal.example.test".into(), 22, "deploy".into()),
            ]
        );
    }

    #[test]
    fn profile_jumps_chain() {
        let outer = profile("outer", AuthMethod::Agent, None);
        let middle = profile(
            "middle",
            AuthMethod::KeyFile { path: "/k".into() },
            Some(JumpHost::Profile {
                profile_id: outer.id,
            }),
        );
        let target = profile(
            "target",
            AuthMethod::Password,
            Some(JumpHost::Profile {
                profile_id: middle.id,
            }),
        );
        let route = route_of(&target, &[outer.clone(), middle.clone()]).unwrap();
        let labels: Vec<&str> = route.iter().map(|h| h.label.as_str()).collect();
        assert_eq!(labels, ["outer", "middle", "target"]);
        assert_eq!(route[0].auth, HopAuth::Agent);
        assert_eq!(route[1].profile_id, Some(middle.id));
    }

    #[test]
    fn a_missing_jump_profile_is_invalid_input() {
        let target = profile(
            "target",
            AuthMethod::Password,
            Some(JumpHost::Profile {
                profile_id: ProfileId::new(),
            }),
        );
        let err = route_of(&target, &[]).unwrap_err();
        assert_eq!(err.kind(), "invalidInput");
    }

    #[test]
    fn loops_are_refused() {
        let mut a = profile("a", AuthMethod::Agent, None);
        let b = profile(
            "b",
            AuthMethod::Agent,
            Some(JumpHost::Profile { profile_id: a.id }),
        );
        a.jump = Some(JumpHost::Profile { profile_id: b.id });
        let err = route_of(&a, &[a.clone(), b.clone()]).unwrap_err();
        assert!(err.to_string().contains("loop"), "{err}");

        let p = profile(
            "x",
            AuthMethod::SshConfigHost {
                alias: "loop-a".into(),
            },
            None,
        );
        let err = route_of(&p, &[]).unwrap_err();
        assert!(err.to_string().contains("loop"), "{err}");
    }

    #[test]
    fn the_config_is_only_read_when_needed() {
        let p = profile("alpha", AuthMethod::Agent, None);
        let lookup = |_: ProfileId| Err(CoreError::NotFound("connection".into()));
        let load = || -> CoreResult<SshConfigFile> { panic!("config read") };
        assert_eq!(Resolver::new(&lookup, &load).route(&p).unwrap().len(), 1);
    }
}
