# OmniWork — build progress

Autonomous build log (loop mode). Newest status at top.

## Status: PUBLISHED · validating CI, then tag release

Repo live: **https://github.com/VedSoni-dev/omniwork** (public, MIT)

### Proven working ✅
- **Packaged app runs**: `OmniWork.exe` boots the gateway from the bundled Node,
  native SQLite works, `/v1/models` → 200, real completion "PACKAGED OK" from a free
  model — zero keys, zero config.
- **End-to-end smoke test passes** (gateway → agent tool loop → file written).
- Source published to GitHub; 87MB node binary purged from history; clean tree.

### Done
- [x] Full Electron app: sidecar + agent + tools + Claude-Code/Cowork UI
- [x] OmniRoute bundled + spawned on a bundled real Node binary
- [x] App icon, README, CONTRIBUTING, LICENSE (MIT), tests
- [x] CI + Release GitHub workflows
- [x] Public repo created + pushed (history cleaned)

### In progress
- [ ] CI boot-check green on clean Ubuntu runner (validates fresh clone)
- [ ] Local NSIS installer (flaky on this box — file locks; not blocking, release CI builds it)

### Next
- [ ] Tag `v0.1.0` → release workflow builds win/mac/linux installers → GitHub Release
- [ ] Confirm release artifacts attach; update README download links

### Notes
- Local Windows installer build is finicky (ffmpeg.dll lock after running the app;
  long NSIS compression). The GitHub Actions release job is the real distribution path —
  each OS builds natively and attaches installers to the Release.
