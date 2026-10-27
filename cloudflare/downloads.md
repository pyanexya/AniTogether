# Public desktop downloads

`/downloads` is public and independent of login/D1. The checked-in manifest starts
with `release: null`: no fake version, hash, or usable download button. Only exact
allowlisted release filenames are served. Local assets must both exist with the
recorded byte sizes, or the Worker suppresses the entire release.

## Preferred: public GitHub release (repository stays public)

1. Build the Windows installer and corresponding source ZIP from the **same
   verified commit**. Include LICENSE, attribution, lockfiles and build scripts in
   source. Use `git archive --format=zip <commit>` rather than zipping a worktree:
   dependencies, ignored credentials, cache and local outputs must never enter it.
2. Review source archive and secret-scan it. SHA-256 describes integrity, not
   authenticity or malware scanning. Do not call the unsigned build signed.
3. Publish a GitHub prerelease `vVERSION` with exactly
   `AnixArtix_VERSION_x64-setup.exe` and `AnixArtix_VERSION_source.zip`.
   Actions artifacts are not public release links. A scoped release job can use
   the built-in `GITHUB_TOKEN` with `contents: write`; no new personal token needed.
   Never grant release publishing to pull requests.
4. After verifying the actual public asset downloads (bytes/hash), run:

   ```sh
   node cloudflare/scripts/prepare-download.mjs /path/setup.exe /path/source.zip VERSION COMMIT YYYY-MM-DDTHH:mm:ssZ github
   ```

5. Review and commit only `cloudflare/public/downloads/release.json`; deploy portal.
   GitHub asset URLs are confined to `pyanexya/AniTogether`, exact version tag/filenames.
   Do not overwrite published assets in place. Use a new version for a new build.

## Optional: Workers Static Assets

Use the same command with final argument `assets`. It copies both files into
`cloudflare/public/downloads` and calculates their sizes/hashes. Review both before
explicitly committing binaries and deploying. Source must remain publicly available
with the executable even if the repository later becomes private. No R2 is needed.

Cloudflare's individual static asset limit is 25 MiB on free and paid plans:
https://developers.cloudflare.com/workers/platform/limits/
The importer enforces this limit in `assets` mode. The existing worker-first
routing means these download requests invoke the Worker and use its request quota;
this is not a claim of unlimited free Worker requests.

The manifest's release date is supplied explicitly (publication date), not inferred
from file timestamps. Size and SHA-256 are always calculated from supplied bytes.
Importing does not publish, sign, certify or execute the installer.

The publication workflow checks out the successful **build commit** at the root
for version and corresponding source, and separately checks out its own dispatched
workflow commit at `release-tools/` for the importer. This allows release tooling
to be added after a build without changing or mislabeling the build's source.
The workflow only permits publication in `pyanexya/AniTogether`.
