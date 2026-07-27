![Screenshot](https://github.com/user-attachments/assets/1cd9d6bd-db62-41c8-8ce9-01bf1418f6ff)

# Katachi

Small Electron app for playing games against KataGo's human SL network.

## Run

```powershell
electron .
```

If Electron is not installed globally:

```powershell
npm install
npm start
```

## Setup

In the app:

1. Locate the KataGo executable.
2. Locate the human network, for example `b18c384nbt-humanv0.bin.gz`.
3. Optionally choose a KataGo analysis config. If none is chosen, the app writes a small generated config under Electron's user-data directory.
4. Pick the human color and profile, then start KataGo.

The default profile is `rank_5k`. KataGo also supports profiles like `rank_3d`, `preaz_10k`, and `proyear_2020`.

## Notes

The app runs KataGo in analysis mode using the human model as the main model:

```text
katago analysis -config <config> -model <human-network> -quit-without-waiting
```

For each engine turn it sends a one-visit query with `includePolicy: true`, passes `humanSLProfile` in `overrideSettings`, and samples from `humanPolicy` if present or `policy` otherwise.

Made by Codex 5.5, though reusing a bunch of human-written Ogatak modules.
