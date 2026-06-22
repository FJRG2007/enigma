# @enigmax/dashboard

The browser UI for [enigma](https://github.com/FJRG2007/enigma)'s local savings
dashboard: a single static page plus a vendored charting library.

You do not install this directly. enigma fetches it on demand the first time you open the
dashboard (`enigma dashboard`) or enable it (`enigma config dashboard on`), and keeps it up
to date on `enigma update`.

Shipping the UI separately keeps it out of the base `enigma-cli` package, so people who
never open the dashboard never download it. The dashboard runs only on your own machine
(`127.0.0.1`); it is never exposed to the network.

## License

Apache-2.0. The bundled charting library retains its upstream Apache-2.0 license header.
