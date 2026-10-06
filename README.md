# oculix

## Development

The repository pins its development toolchain with `mise`.
The baseline checks use `hk`, `actionlint`, `shellcheck`, and `zizmor`.

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
