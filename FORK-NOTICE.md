# AnixArtix

Independent modified fork of [AniXFlow](https://github.com/MjKey/AniXFlow), based on upstream commit c1bfe6347a1e21c25f96f2b9e011606bd6f95011.

Copyright notices and the original GPL version 2 license are retained in LICENSE and the source tree. AniXFlow itself derives from AniDesk. AnixArtix is not an official Anixart product and does not claim affiliation with its authors.

Changes include original branding and interface, a separately hosted playback-state relay, player reliability work and Tauri/Rust native-host migration and trust-boundary fixes. Distributing binaries requires providing corresponding source under the included GPL license. The relay does not distribute video or transfer account credentials; each participant must have independent legitimate access to the content.

Upstream automatic updates are disabled so this fork cannot silently replace itself with a different product. Windows artifacts produced by the included workflow are unsigned unless the owner separately configures signing. No hosted synchronization service is bundled or promised.

The legacy Electron host sources are retained for provenance/reference only. They are not part of the Tauri application runtime or installer. The room relay is a separate service, not a Node sidecar.
