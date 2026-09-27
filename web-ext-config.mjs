// Keeps local test data and tooling out of the packaged add-on (web-ext build/sign/lint).
export default {
	ignoreFiles: ["samples", "samples/**", "tools", "tools/**", "web-ext-config.mjs", "README.md", ".gitignore", "LICENSE", "package.py", "release.py", "updates.json", "build", "build/**", "dist", "dist/**", "*.xpi"],
};
