import { defineConfig, devices } from "@playwright/test";

const port = 4173;

export default defineConfig({
    testDir: "./test",
    fullyParallel: false,
    workers: 1,
    reporter: process.env.CI ? "dot" : "list",
    use: {
        baseURL: `http://localhost:${port}`,
        // Every timing assertion here is measured off real animation frames.
        launchOptions: { args: ["--disable-lcd-text"] }
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
    webServer: {
        command: "node test/server.mjs",
        port,
        reuseExistingServer: !process.env.CI,
        stdout: "ignore"
    }
});
