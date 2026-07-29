cask "omniwork" do
  version "0.11.1"
  sha256 "8f8892490e6c83ff7cca91c14374003e84253e94b75f0bee20938e524324a127"

  url "https://github.com/VedSoni-dev/omniwork/releases/download/v#{version}/OmniWork-#{version}-arm64.dmg"
  name "OmniWork"
  desc "Free, local, Claude Code-style desktop coding agent"
  homepage "https://github.com/VedSoni-dev/omniwork"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: :monterey

  app "OmniWork.app"

  zap trash: [
    "~/Library/Application Support/omniwork",
    "~/Library/Preferences/com.omniwork.app.plist",
    "~/Library/Saved Application State/com.omniwork.app.savedState",
  ]

  caveats <<~EOS
    OmniWork is not signed with an Apple Developer certificate yet, so macOS
    will block the first launch unless you either:

      installed with:   brew install --cask --no-quarantine VedSoni-dev/tap/omniwork
      or, once:         right-click OmniWork.app in /Applications → Open
  EOS
end
