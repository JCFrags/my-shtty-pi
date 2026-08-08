# Demo

This demo does not load as part of the package.

1. Copy `demo.progressive-tools.json` to `~/.pi/agent/progressive-tools.json`.
2. Start Pi with both extensions:

       pi -e /path/to/pi-progressive-tools/examples/demo-tools.ts -e /path/to/pi-progressive-tools/extensions/index.ts

3. Run `/tool-audit demo`.
4. Ask: `What is the weather in Paris?`
5. The model should call `search_tools` and load `demo_weather_lookup`.

Restore your normal user configuration after the test.
