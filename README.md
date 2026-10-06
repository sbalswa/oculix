# oculix

## Development

The repository pins its development toolchain with `mise`.
The baseline checks use `hk`, `jactionlint`, `shellcheck`, and `zizmor`.
GitHub Actions policy is defined in `.github/jactionlint.yaml`.

On macOS or Linux:

```sh
./bin/mise install --locked
./bin/mise run setup
./bin/mise run ci
```

On Windows:

```bat
bin\mise.cmd install --locked
bin\mise.cmd run setup
bin\mise.cmd run ci
```
