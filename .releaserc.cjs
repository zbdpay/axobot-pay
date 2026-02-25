const isDryRun = process.env.SEMANTIC_RELEASE_DRY_RUN === "true";
const repositoryUrl = process.env.SEMANTIC_RELEASE_REPOSITORY_URL || (process.env.GITHUB_REPOSITORY
  ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY}.git`
  : `file://${process.cwd()}`);

const plugins = [
  ["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
  ["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
  "@semantic-release/changelog",
];

if (!isDryRun) {
  plugins.push(
    ["@semantic-release/npm", { npmPublish: true, tarballDir: "dist-release" }],
    "@semantic-release/github",
    [
      "@semantic-release/git",
      {
        assets: ["CHANGELOG.md", "package.json", "package-lock.json"],
        message:
          "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
  );
}

module.exports = {
  branches: ["main"],
  repositoryUrl,
  tagFormat: "${version}",
  plugins,
};
