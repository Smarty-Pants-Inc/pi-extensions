# pi-input-prefix

Theme-aware rounded prompt editor for Pi. It preserves native editing, history, autocomplete, IME, and keybindings while adding a compact prompt token. The Signalridge Ridgeline profile uses `›` by default; set `PI_INPUT_PREFIX` to any one-cell glyph to customize it.

Fullscreen mouse clicks follow the rendered shell prompt: clicking the command places the cursor in the command, while clicking `!` selects the semantic leading bang. Wrapped rows and autocomplete retain native mouse handling. The standalone working indicator remains enabled.

Startup composition preserves a completed large paste using the focused editor's public expanded-text getter, restoring it after the host copies the draft. It does not read private paste storage or retain snapshots for later input. If the public focus/expanded-text APIs are unavailable or focus is not an editor, the host's normal text-copy behavior applies.

## Install

```bash
pi install npm:@signalridge/pi-input-prefix
```

## Use from this checkout

From the repository root:

```bash
pi -e ./packages/pi-input-prefix
```
