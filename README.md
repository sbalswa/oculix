# oculix

## Development

The repository pins its development toolchain with `mise`.
The baseline checks use `hk`, `betterleaks`, `jactionlint`, `shellcheck`, and
`zizmor`.
GitHub Actions policy is defined in `.github/jactionlint.yaml`.
Repository hygiene checks enforce LF line endings, final newlines, executable
shebang consistency, conflict-free filenames and contents, valid symlinks,
secret detection, and a 500 KiB file-size ceiling.
The versioned Git hooks also prevent direct commits to `main` or `master` and
require conventional commit messages. Editor defaults live in `.editorconfig`.

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
