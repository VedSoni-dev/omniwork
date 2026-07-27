# OmniWork Homebrew tap

Install [OmniWork](https://github.com/VedSoni-dev/omniwork) — the free, local,
Claude Code-style coding agent:

```sh
brew install --cask --no-quarantine VedSoni-dev/tap/omniwork
```

`--no-quarantine` skips the Gatekeeper block on the (unsigned) app. Without it,
right-click OmniWork.app → Open once after installing.

---

## Maintaining (in the omniwork repo)

This directory is the canonical source; the published tap lives at
`VedSoni-dev/homebrew-tap` and mirrors it. On each release:

```sh
# 1. compute the new artifact's checksum
curl -sL "https://github.com/VedSoni-dev/omniwork/releases/download/v<VER>/OmniWork-<VER>-arm64.dmg" | shasum -a 256

# 2. bump `version` and `sha256` in Casks/omniwork.rb (here), commit

# 3. mirror to the tap repo
git clone git@github.com:VedSoni-dev/homebrew-tap.git /tmp/tap
cp -R packaging/homebrew-tap/* /tmp/tap/
cd /tmp/tap && git add -A && git commit -m "omniwork <VER>" && git push
```

Publishing for the first time: create a **public repo named exactly
`homebrew-tap`** under the org/user, then run step 3. Nothing else — Homebrew
resolves `VedSoni-dev/tap` to that repo automatically.
