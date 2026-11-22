# Hinweise zu mitgelieferten Fremddateien

## Bamboo Cosmetics (Cosmiq-Patch)

- Datei: `resources/bamboo-cosmetics-26.3-fabric.jar`
- Inhalt: gepatchte Fassung des Cosmiq-Clients als Fabric-Mod (`id: cosmiq`),
  gebaut im Projekt `cosmiq-patch/`. Die Mod liest `<instanz>/bamboo/cosmetics`
  und zeigt die Pakete aus dem Shop im Spiel an.
- Lizenz laut `fabric.mod.json`: `LicenseRef-All-Rights-Reserved`.
- Stand: 0.3.7.5-26.3-fabric, Abhängigkeiten `fabricloader >= 0.19.5`,
  `minecraft 26.3`, `java >= 25`, `fabric-api`.

**Vor einer öffentlichen Verteilung zu klären:** Das Patch-README hält fest,
dass der Quell-Jar ohne schriftliche Freigabe nicht weitergegeben werden darf
und die gebauten Jars für den Bamboo-Launcher-Build bestimmt sind. Die
Weitergabe an Endnutzer über den Installer fällt darunter. Bis eine
schriftliche Freigabe dokumentiert ist, gilt:

- Die Jar wird nur im Launcher-Build verwendet, nicht separat veröffentlicht.
- Der Launcher legt sie ausschließlich in 26.3-Fabric-Instanzen mit Fabric API
  ab und nimmt nur seine eigene, unveränderte Kopie wieder zurück.
- Eine vom Nutzer installierte Cosmiq-Fassung wird nie überschrieben oder
  entfernt.

Wenn die Freigabe nicht erteilt wird, ist die Alternative: Jar nicht bündeln,
sondern beim ersten Start optional aus dem eigenen Kanal laden und den
Launcher ohne sie voll funktionsfähig lassen (die Cosmetics-Pakete bleiben
dann nur in der Bibliothek sichtbar).

## CurseForge-API-Key

- Datei: `resources/curseforge-key.txt`
- Zweck: Suche, Projektseiten und Modpack-Importe ohne eigenen Key pro Nutzer.
- Der Key ist absichtlich Teil des Builds (siehe 0.2.8) und kein Geheimnis im
  Sinne eines Nutzerkontos; er wird nicht geloggt und nicht an die Oberfläche
  ausgeliefert.
