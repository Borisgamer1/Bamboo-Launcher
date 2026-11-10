//! Die Einstellungen aus dem Launcher, übersetzt in `options.txt`-Zeilen.
//!
//! Minecraft hat für jede Option einen eigenen Schlüssel und ein eigenes
//! Format: Prozentwerte liegen als 0..1 in der Datei, das Sichtfeld als Stufe
//! um 70° (−1..1), Schalter als `true`/`false`, und die Steuerung steht als
//! `key_key.forward:key.keyboard.w` mitten zwischen den Optionen. Die
//! Oberfläche arbeitet dagegen mit Prozent und Gradzahlen – ohne diese
//! Übersetzung landet nichts davon im Spiel.
//!
//! Unbekannte Schlüssel werden ausgelassen statt durchgereicht: Die Datei ist
//! Klartext, und ein Wert mit Zeilenumbruch würde die übrigen Einstellungen
//! zerstören.

use serde_json::{Map, Value};

/// Eine Zeile für die `options.txt`.
pub type OptionPair = (String, String);

/// Wie ein Wert aus der Oberfläche in die Datei kommt.
enum Kind {
    /// Ganzzahl, auf diese Grenzen begrenzt.
    Integer(f64, f64),
    /// Prozent in der Oberfläche, im Spiel 0..1.
    Fraction,
    /// Wie [`Kind::Fraction`], aber mit eigenen Grenzen (Entity-Sichtweite
    /// reicht von 0,5 bis 5,0 statt von 0 bis 1).
    Percent(f64, f64),
    /// Gradzahl des Sichtfeld-Reglers: Minecraft speichert `(Grad − 70) / 40`.
    Fov,
    /// Schalter als `true`/`false`.
    Flag,
    /// Auswahlwert über eine feste Zuordnung: Was nicht in der Liste steht,
    /// kommt nicht in die Datei – so kann kein Tippfehler eine Einstellung
    /// auf einen Wert setzen, den das Spiel nicht kennt.
    Choice(&'static [(&'static str, &'static str)]),
}

struct Mapping {
    /// Schlüssel im Einstellungs-Panel der Oberfläche.
    ui: &'static str,
    /// Schlüssel in der `options.txt`.
    text: &'static str,
    kind: Kind,
}

/// `graphicsMode` gibt es seit 1.19; davor hieß derselbe Schalter `graphics`
/// und kannte nur schnell/schön. Beide Schlüssel werden geschrieben, damit
/// auch alte Modpacks die Einstellung übernehmen – was das Spiel nicht kennt,
/// ignoriert es.
const GRAPHICS_MODERN: &[(&str, &str)] = &[
    ("fast", "fast"),
    ("fancy", "fancy"),
    ("fabulous", "fabulous"),
];
const GRAPHICS_LEGACY: &[(&str, &str)] =
    &[("fast", "false"), ("fancy", "true"), ("fabulous", "true")];
const MAIN_HAND: &[(&str, &str)] = &[("right", "right"), ("left", "left")];

/// Dieselbe Reihenfolge wie im Panel: Die Datei bleibt so lesbar, und zwei
/// Starts hintereinander erzeugen exakt denselben Inhalt.
const MAPPINGS: &[Mapping] = &[
    // Video
    Mapping {
        ui: "renderDistance",
        text: "renderDistance",
        kind: Kind::Integer(2.0, 32.0),
    },
    Mapping {
        ui: "simulationDistance",
        text: "simulationDistance",
        kind: Kind::Integer(5.0, 32.0),
    },
    Mapping {
        ui: "fov",
        text: "fov",
        kind: Kind::Fov,
    },
    Mapping {
        ui: "guiScale",
        text: "guiScale",
        kind: Kind::Integer(0.0, 4.0),
    },
    Mapping {
        ui: "maxFramerate",
        text: "maxFramerate",
        kind: Kind::Integer(10.0, 260.0),
    },
    Mapping {
        ui: "vsync",
        text: "enableVsync",
        kind: Kind::Flag,
    },
    Mapping {
        ui: "graphicsMode",
        text: "graphicsMode",
        kind: Kind::Choice(GRAPHICS_MODERN),
    },
    Mapping {
        ui: "graphicsMode",
        text: "graphics",
        kind: Kind::Choice(GRAPHICS_LEGACY),
    },
    Mapping {
        ui: "particles",
        text: "particles",
        kind: Kind::Integer(0.0, 2.0),
    },
    Mapping {
        ui: "mipmapLevels",
        text: "mipmapLevels",
        kind: Kind::Integer(0.0, 4.0),
    },
    Mapping {
        ui: "gamma",
        text: "gamma",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "entityDistanceScaling",
        text: "entityDistanceScaling",
        kind: Kind::Percent(0.5, 5.0),
    },
    Mapping {
        ui: "biomeBlendRadius",
        text: "biomeBlendRadius",
        kind: Kind::Integer(0.0, 7.0),
    },
    Mapping {
        ui: "entityShadows",
        text: "entityShadows",
        kind: Kind::Flag,
    },
    Mapping {
        ui: "fovEffectScale",
        text: "fovEffectScale",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "screenEffectScale",
        text: "screenEffectScale",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "vignette",
        text: "vignette",
        kind: Kind::Flag,
    },
    Mapping {
        ui: "renderClouds",
        text: "renderClouds",
        kind: Kind::Flag,
    },
    // Audio
    Mapping {
        ui: "soundCategory_master",
        text: "soundCategory_master",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "soundCategory_music",
        text: "soundCategory_music",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "soundCategory_record",
        text: "soundCategory_record",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "soundCategory_weather",
        text: "soundCategory_weather",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "soundCategory_block",
        text: "soundCategory_block",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "soundCategory_hostile",
        text: "soundCategory_hostile",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "soundCategory_neutral",
        text: "soundCategory_neutral",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "soundCategory_player",
        text: "soundCategory_player",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "soundCategory_ambient",
        text: "soundCategory_ambient",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "soundCategory_voice",
        text: "soundCategory_voice",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "soundCategory_ui",
        text: "soundCategory_ui",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "directionalAudio",
        text: "directionalAudio",
        kind: Kind::Flag,
    },
    Mapping {
        ui: "showSubtitles",
        text: "showSubtitles",
        kind: Kind::Flag,
    },
    // Steuerung
    Mapping {
        ui: "mouseSensitivity",
        text: "mouseSensitivity",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "invertYMouse",
        text: "invertYMouse",
        kind: Kind::Flag,
    },
    Mapping {
        ui: "autoJump",
        text: "autoJump",
        kind: Kind::Flag,
    },
    Mapping {
        ui: "rawMouseInput",
        text: "rawMouseInput",
        kind: Kind::Flag,
    },
    Mapping {
        ui: "bobView",
        text: "bobView",
        kind: Kind::Flag,
    },
    Mapping {
        ui: "toggleCrouch",
        text: "toggleCrouch",
        kind: Kind::Flag,
    },
    Mapping {
        ui: "toggleSprint",
        text: "toggleSprint",
        kind: Kind::Flag,
    },
    Mapping {
        ui: "mainHand",
        text: "mainHand",
        kind: Kind::Choice(MAIN_HAND),
    },
    Mapping {
        ui: "attackIndicator",
        text: "attackIndicator",
        kind: Kind::Integer(0.0, 2.0),
    },
    // Chat
    Mapping {
        ui: "chatVisibility",
        text: "chatVisibility",
        kind: Kind::Integer(0.0, 2.0),
    },
    Mapping {
        ui: "chatOpacity",
        text: "chatOpacity",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "chatScale",
        text: "chatScale",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "chatWidth",
        text: "chatWidth",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "chatLineSpacing",
        text: "chatLineSpacing",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "textBackgroundOpacity",
        text: "textBackgroundOpacity",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "chatColors",
        text: "chatColors",
        kind: Kind::Flag,
    },
    Mapping {
        ui: "chatLinks",
        text: "chatLinks",
        kind: Kind::Flag,
    },
    Mapping {
        ui: "autoSuggestions",
        text: "autoSuggestions",
        kind: Kind::Flag,
    },
    // Barrierefreiheit
    Mapping {
        ui: "narrator",
        text: "narrator",
        kind: Kind::Integer(0.0, 3.0),
    },
    Mapping {
        ui: "highContrast",
        text: "highContrast",
        kind: Kind::Flag,
    },
    Mapping {
        ui: "highContrastBlockOutline",
        text: "highContrastBlockOutline",
        kind: Kind::Flag,
    },
    Mapping {
        ui: "damageTiltStrength",
        text: "damageTiltStrength",
        kind: Kind::Fraction,
    },
    Mapping {
        ui: "menuBackgroundBlurriness",
        text: "menuBackgroundBlurriness",
        kind: Kind::Integer(0.0, 10.0),
    },
    Mapping {
        ui: "forceUnicodeFont",
        text: "forceUnicodeFont",
        kind: Kind::Flag,
    },
    Mapping {
        ui: "notificationDisplayTime",
        text: "notificationDisplayTime",
        kind: Kind::Percent(0.1, 2.0),
    },
];

/// Alle Optionen des Panels als Zeilen für die `options.txt`. Fehlt ein Wert,
/// bleibt die Zeile weg; die vorhandene Einstellung im Spiel gilt weiter.
pub fn options_from_ui(values: &Map<String, Value>) -> Vec<OptionPair> {
    MAPPINGS
        .iter()
        .filter_map(|mapping| {
            let value = values.get(mapping.ui)?;
            let text = format_value(&mapping.kind, value)?;
            Some((mapping.text.to_string(), text))
        })
        .collect()
}

fn format_value(kind: &Kind, value: &Value) -> Option<String> {
    match kind {
        Kind::Integer(min, max) => {
            let number = number_of(value)?.round().clamp(*min, *max);
            Some(format!("{}", number as i64))
        }
        Kind::Fraction => {
            let number = (number_of(value)? / 100.0).clamp(0.0, 1.0);
            Some(decimal(number))
        }
        Kind::Percent(min, max) => {
            let number = (number_of(value)? / 100.0).clamp(*min, *max);
            Some(decimal(number))
        }
        Kind::Fov => {
            let number = ((number_of(value)? - 70.0) / 40.0).clamp(-1.0, 1.0);
            Some(decimal(number))
        }
        Kind::Flag => Some(flag_of(value)?.to_string()),
        Kind::Choice(table) => {
            let text = value.as_str()?.trim().to_ascii_lowercase();
            table
                .iter()
                .find(|(ui, _)| *ui == text)
                .map(|(_, written)| (*written).to_string())
        }
    }
}

/// Die Steuerung steht in der `options.txt` als `key_<Aktion>:<Taste>` –
/// `key.forward` wird also zu `key_key.forward`, der Wert bleibt der
/// Tastencode der Oberfläche (`key.keyboard.w`).
pub fn keybinds_from_ui(values: &Map<String, Value>) -> Vec<OptionPair> {
    let mut pairs: Vec<OptionPair> = values
        .iter()
        .filter(|(action, _)| is_plain_identifier(action))
        .filter_map(|(action, token)| {
            let token = token.as_str()?.trim().to_ascii_lowercase();
            if !is_plain_token(&token) {
                return None;
            }
            Some((format!("key_{action}"), token))
        })
        .collect();
    pairs.sort();
    pairs
}

fn number_of(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse().ok(),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn flag_of(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(flag) => Some(*flag),
        Value::Number(number) => Some(number.as_f64().unwrap_or(0.0) != 0.0),
        Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "ja" | "yes" => Some(true),
            "false" | "0" | "nein" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// Minecraft schreibt Dezimalwerte mit Punkt und ohne überflüssige Nullen.
fn decimal(value: f64) -> String {
    let rounded = (value * 1000.0).round() / 1000.0;
    if rounded.fract() == 0.0 {
        return format!("{}", rounded as i64);
    }
    let text = format!("{rounded:.3}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Aktionsnamen wie `key.forward` oder `key.hotbar.1`.
fn is_plain_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// Tastencodes wie `key.keyboard.left.shift` oder `key.mouse.4`. Erlaubt ist
/// nur, was auch in der Datei stehen darf – kein Leerzeichen, kein Doppelpunkt
/// am Rand, kein Zeilenumbruch.
fn is_plain_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '+'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    fn find(pairs: &[OptionPair], key: &str) -> Option<String> {
        pairs
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    }

    #[test]
    fn writes_percentages_and_fov_in_the_format_minecraft_expects() {
        let pairs = options_from_ui(&map(json!({
            "gamma": 50,
            "fov": 70,
            "fovEffectScale": 100,
            "entityDistanceScaling": 500,
            "notificationDisplayTime": 120,
        })));
        assert_eq!(find(&pairs, "gamma").as_deref(), Some("0.5"));
        assert_eq!(find(&pairs, "fov").as_deref(), Some("0"));
        assert_eq!(find(&pairs, "fovEffectScale").as_deref(), Some("1"));
        // Eigene Grenzen: 500 % sind 5,0 und nicht auf 1 gekappt.
        assert_eq!(find(&pairs, "entityDistanceScaling").as_deref(), Some("5"));
        assert_eq!(
            find(&pairs, "notificationDisplayTime").as_deref(),
            Some("1.2")
        );
    }

    #[test]
    fn maps_fov_degrees_around_seventy() {
        let low = options_from_ui(&map(json!({ "fov": 30 })));
        let high = options_from_ui(&map(json!({ "fov": 110 })));
        let narrow = options_from_ui(&map(json!({ "fov": 90 })));
        assert_eq!(find(&low, "fov").as_deref(), Some("-1"));
        assert_eq!(find(&high, "fov").as_deref(), Some("1"));
        assert_eq!(find(&narrow, "fov").as_deref(), Some("0.5"));
    }

    #[test]
    fn writes_toggles_clamped_numbers_and_choices() {
        let pairs = options_from_ui(&map(json!({
            "vsync": true,
            "showSubtitles": false,
            "renderDistance": 999,
            "guiScale": 3,
            "mainHand": "left",
            "graphicsMode": "fancy",
        })));
        assert_eq!(find(&pairs, "enableVsync").as_deref(), Some("true"));
        assert_eq!(find(&pairs, "showSubtitles").as_deref(), Some("false"));
        assert_eq!(find(&pairs, "renderDistance").as_deref(), Some("32"));
        assert_eq!(find(&pairs, "guiScale").as_deref(), Some("3"));
        assert_eq!(find(&pairs, "mainHand").as_deref(), Some("left"));
        // Neu und alt: 1.19+ liest graphicsMode, ältere Packs graphics.
        assert_eq!(find(&pairs, "graphicsMode").as_deref(), Some("fancy"));
        assert_eq!(find(&pairs, "graphics").as_deref(), Some("true"));
    }

    #[test]
    fn ignores_what_minecraft_does_not_know() {
        let pairs = options_from_ui(&map(json!({
            "unbekannt": 5,
            "mainHand": "diagonal",
            "renderDistance": "viele",
        })));
        assert!(pairs.is_empty());
    }

    #[test]
    fn writes_keybinds_with_the_minecraft_prefix() {
        let pairs = keybinds_from_ui(&map(json!({
            "key.forward": "key.keyboard.w",
            "key.fullscreen": "key.keyboard.f11",
            "key.attack": "key.mouse.left",
        })));
        assert_eq!(
            find(&pairs, "key_key.forward").as_deref(),
            Some("key.keyboard.w")
        );
        assert_eq!(
            find(&pairs, "key_key.fullscreen").as_deref(),
            Some("key.keyboard.f11")
        );
        assert_eq!(
            find(&pairs, "key_key.attack").as_deref(),
            Some("key.mouse.left")
        );
    }

    #[test]
    fn refuses_to_smuggle_newlines_into_the_options_file() {
        let pairs = keybinds_from_ui(&map(json!({
            "key.forward": "key.keyboard.w\nrenderDistance:32",
            "../boese": "key.keyboard.a",
        })));
        assert!(pairs.is_empty());

        let broken = options_from_ui(&map(json!({ "mainHand": "right\nfov:1" })));
        assert!(broken.is_empty());
    }

    #[test]
    fn clamps_negative_and_oversized_numbers() {
        let pairs = options_from_ui(&map(json!({
            "renderDistance": -5,
            "gamma": -40,
            "mouseSensitivity": 500,
        })));
        assert_eq!(find(&pairs, "renderDistance").as_deref(), Some("2"));
        assert_eq!(find(&pairs, "gamma").as_deref(), Some("0"));
        assert_eq!(find(&pairs, "mouseSensitivity").as_deref(), Some("1"));
    }
}
