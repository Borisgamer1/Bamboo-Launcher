//! Auflösung der Abhängigkeiten.
//!
//! Ausgangspunkt ist genau eine Version; von dort läuft eine Breitensuche über
//! die Pflichtabhängigkeiten. Optionale, eingebettete und inkompatible Einträge
//! werden nicht installiert, aber protokolliert – der Nutzer soll sehen, warum
//! etwas fehlt. Tiefe und Knotenzahl sind begrenzt, damit ein fehlerhaftes oder
//! bösartiges Metadaten-Netz den Launcher nicht in eine Endlosschleife zieht.

use super::*;
use std::collections::{HashMap, HashSet, VecDeque};

pub const DEFAULT_MAX_DEPTH: usize = 8;
pub const DEFAULT_MAX_NODES: usize = 128;

#[derive(Debug, Clone)]
pub struct ResolveOptions {
    pub target: ModTarget,
    pub max_depth: usize,
    pub max_nodes: usize,
}

impl ResolveOptions {
    pub fn new(target: ModTarget) -> Self {
        Self {
            target,
            max_depth: DEFAULT_MAX_DEPTH,
            max_nodes: DEFAULT_MAX_NODES,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PlannedMod {
    pub version: Version,
    pub depth: usize,
    pub required_by: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanNote {
    Optional {
        project: String,
        parent: String,
    },
    Embedded {
        project: String,
        parent: String,
    },
    Incompatible {
        project: String,
        parent: String,
    },
    Tool {
        project: String,
        parent: String,
    },
    Include {
        project: String,
        parent: String,
    },
    AlreadyInstalled {
        project: String,
        parent: String,
    },
    Conflict {
        project: String,
        planned: String,
        requested: String,
        parent: String,
    },
}

impl PlanNote {
    pub fn describe(&self) -> String {
        match self {
            Self::Optional { project, parent } => {
                format!("Optional, nicht installiert: {project} (von {parent})")
            }
            Self::Embedded { project, parent } => {
                format!("Bereits in {parent} enthalten: {project}")
            }
            Self::Incompatible { project, parent } => {
                format!("Laut Metadaten inkompatibel: {project} (von {parent})")
            }
            Self::Tool { project, parent } => {
                format!("Nur Werkzeug, nicht installiert: {project} (von {parent})")
            }
            Self::Include { project, parent } => {
                format!("Wird mitgeliefert, nicht separat installiert: {project} (von {parent})")
            }
            Self::AlreadyInstalled { project, parent } => {
                format!("Bereits installiert: {project} (von {parent})")
            }
            Self::Conflict {
                project,
                planned,
                requested,
                parent,
            } => format!(
                "Versionskonflikt: {project} ist als {planned} geplant, {parent} fordert {requested}"
            ),
        }
    }
}

#[derive(Debug, Clone)]
pub struct UnresolvedDependency {
    pub project: Option<String>,
    pub parent: String,
    pub reason: String,
}

impl UnresolvedDependency {
    pub fn describe(&self) -> String {
        match &self.project {
            Some(project) => format!("{project} (benötigt von {}) – {}", self.parent, self.reason),
            None => format!(
                "Unbekannte Abhängigkeit von {} – {}",
                self.parent, self.reason
            ),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ModPlan {
    pub primary: Version,
    /// Primärversion zuerst, danach in Breitensuch-Reihenfolge.
    pub mods: Vec<PlannedMod>,
    pub notes: Vec<PlanNote>,
    pub unresolved: Vec<UnresolvedDependency>,
}

impl ModPlan {
    pub fn missing_required(&self) -> Vec<String> {
        self.unresolved
            .iter()
            .map(UnresolvedDependency::describe)
            .collect()
    }

    pub fn projects(&self) -> HashSet<String> {
        self.mods
            .iter()
            .map(|planned| planned.version.project_id.clone())
            .collect()
    }
}

/// Löst eine Installation auf: Primärversion bestimmen, dann Pflichtabhängigkeiten.
pub async fn plan_install<P: ModProvider>(
    provider: &P,
    project: &str,
    version_id: Option<&str>,
    options: &ResolveOptions,
    installed: &HashSet<String>,
) -> Result<ModPlan> {
    let project = project.trim();
    if project.is_empty() {
        return Err(ModError::Provider {
            provider: provider.source().label(),
            message: "Es wurde kein Projekt angegeben.".to_string(),
        });
    }
    options.target.validate()?;

    let primary = match version_id {
        Some(version_id) => {
            // Bei einer festen Version muss sie auch zum genannten Projekt gehören;
            // sonst installiert ein Zahlendreher still etwas anderes.
            let summary = provider.project(project).await?;
            let version = provider.version(project, version_id).await?;
            if version.project_id != summary.id {
                return Err(ModError::ProjectMismatch {
                    project: summary.id,
                    version: version_id.to_string(),
                });
            }
            version
        }
        None => {
            let versions = provider.versions(project, &options.target).await?;
            pick_version(&versions, &options.target)
                .cloned()
                .ok_or_else(|| ModError::NoMatchingVersion {
                    project: project.to_string(),
                    target: options.target.describe(),
                })?
        }
    };

    resolve_dependencies(provider, primary, options, installed).await
}

async fn resolve_dependencies<P: ModProvider>(
    provider: &P,
    primary: Version,
    options: &ResolveOptions,
    installed: &HashSet<String>,
) -> Result<ModPlan> {
    let mut mods = vec![PlannedMod {
        version: primary.clone(),
        depth: 0,
        required_by: Vec::new(),
    }];
    let mut by_project: HashMap<String, usize> =
        HashMap::from([(primary.project_id.clone(), 0usize)]);
    let mut queue: VecDeque<(Version, usize)> = VecDeque::from([(primary, 0)]);
    let mut visited: HashSet<String> = HashSet::new();
    let mut notes = Vec::new();
    let mut unresolved = Vec::new();

    let mut version_cache: HashMap<String, Vec<Version>> = HashMap::new();
    let mut pinned_cache: HashMap<String, Version> = HashMap::new();

    while let Some((parent, depth)) = queue.pop_front() {
        if !visited.insert(parent.id.clone()) {
            continue;
        }
        let parent_project = parent.project_id.clone();
        let mut dependencies = parent.dependencies.clone();
        dependencies.sort_by(|left, right| {
            left.project_id
                .cmp(&right.project_id)
                .then(left.version_id.cmp(&right.version_id))
        });

        for dependency in dependencies {
            let project = dependency.project_id.clone();
            let label = project.clone().unwrap_or_default();

            match dependency.kind {
                DependencyKind::Optional => {
                    notes.push(PlanNote::Optional {
                        project: label,
                        parent: parent_project.clone(),
                    });
                    continue;
                }
                DependencyKind::Embedded => {
                    notes.push(PlanNote::Embedded {
                        project: label,
                        parent: parent_project.clone(),
                    });
                    continue;
                }
                DependencyKind::Tool => {
                    notes.push(PlanNote::Tool {
                        project: label,
                        parent: parent_project.clone(),
                    });
                    continue;
                }
                DependencyKind::Include => {
                    notes.push(PlanNote::Include {
                        project: label,
                        parent: parent_project.clone(),
                    });
                    continue;
                }
                DependencyKind::Incompatible => {
                    notes.push(PlanNote::Incompatible {
                        project: label,
                        parent: parent_project.clone(),
                    });
                    continue;
                }
                DependencyKind::Required => {}
            }

            let Some(project) = project else {
                unresolved.push(UnresolvedDependency {
                    project: None,
                    parent: parent_project.clone(),
                    reason: "Abhängigkeit nennt keine Projekt-ID".to_string(),
                });
                continue;
            };

            if installed.contains(&project) {
                notes.push(PlanNote::AlreadyInstalled {
                    project,
                    parent: parent_project.clone(),
                });
                continue;
            }

            if let Some(&index) = by_project.get(&project) {
                let existing = &mut mods[index];
                if !existing.required_by.contains(&parent_project) {
                    existing.required_by.push(parent_project.clone());
                }
                if let Some(requested) = &dependency.version_id {
                    if requested != &existing.version.id {
                        notes.push(PlanNote::Conflict {
                            project,
                            planned: existing.version.id.clone(),
                            requested: requested.clone(),
                            parent: parent_project.clone(),
                        });
                    }
                }
                continue;
            }

            let resolved = match &dependency.version_id {
                Some(version_id) => {
                    let cached = pinned_cache.get(version_id).cloned();
                    match cached {
                        Some(version) => Some(version),
                        None => match provider.version(&project, version_id).await {
                            Ok(version) => {
                                pinned_cache.insert(version_id.clone(), version.clone());
                                Some(version)
                            }
                            Err(ModError::NotFound { .. }) => {
                                unresolved.push(UnresolvedDependency {
                                    project: Some(project.clone()),
                                    parent: parent_project.clone(),
                                    reason: format!("Version {version_id} existiert nicht mehr"),
                                });
                                continue;
                            }
                            Err(error) => return Err(error),
                        },
                    }
                }
                None => {
                    let versions = match version_cache.get(&project) {
                        Some(versions) => versions.clone(),
                        None => match provider.versions(&project, &options.target).await {
                            Ok(versions) => {
                                version_cache.insert(project.clone(), versions.clone());
                                versions
                            }
                            Err(ModError::NotFound { .. }) => {
                                unresolved.push(UnresolvedDependency {
                                    project: Some(project.clone()),
                                    parent: parent_project.clone(),
                                    reason: "Projekt existiert nicht mehr".to_string(),
                                });
                                continue;
                            }
                            Err(error) => return Err(error),
                        },
                    };
                    pick_version(&versions, &options.target).cloned()
                }
            };

            let Some(version) = resolved else {
                unresolved.push(UnresolvedDependency {
                    project: Some(project.clone()),
                    parent: parent_project.clone(),
                    reason: format!("keine Version für {}", options.target.describe()),
                });
                continue;
            };

            if version.project_id != project {
                unresolved.push(UnresolvedDependency {
                    project: Some(project.clone()),
                    parent: parent_project.clone(),
                    reason: format!("Version gehört zu Projekt {}", version.project_id),
                });
                continue;
            }

            if installed.contains(&version.project_id) {
                notes.push(PlanNote::AlreadyInstalled {
                    project: version.project_id,
                    parent: parent_project.clone(),
                });
                continue;
            }

            // Zwei Wege können dasselbe Projekt über verschiedene Versionen
            // erreichen; der erste Treffer bleibt, der zweite wird notiert.
            if let Some(&index) = by_project.get(&version.project_id) {
                let existing = &mut mods[index];
                if !existing.required_by.contains(&parent_project) {
                    existing.required_by.push(parent_project.clone());
                }
                if existing.version.id != version.id {
                    notes.push(PlanNote::Conflict {
                        project: version.project_id,
                        planned: existing.version.id.clone(),
                        requested: version.id.clone(),
                        parent: parent_project.clone(),
                    });
                }
                continue;
            }

            let child_depth = depth + 1;
            if child_depth > options.max_depth {
                return Err(ModError::DependencyTooDeep(options.max_depth));
            }
            if mods.len() + 1 > options.max_nodes {
                return Err(ModError::TooManyDependencies(options.max_nodes));
            }

            by_project.insert(version.project_id.clone(), mods.len());
            mods.push(PlannedMod {
                version: version.clone(),
                depth: child_depth,
                required_by: vec![parent_project.clone()],
            });
            queue.push_back((version, child_depth));
        }
    }

    Ok(ModPlan {
        primary: mods[0].version.clone(),
        mods,
        notes,
        unresolved,
    })
}
