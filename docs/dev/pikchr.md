# Debugging Pikchr TextMate rules

Pikchr support in this extension is syntax highlighting only; it does not invoke a repository renderer or preview webview.

Run the checked-in grammar fixtures with:

```sh
npm run grammar-test
```

For interactive TextMate inspection, use the tooling documented by `vscode-textmate` against `pikchr/pikchr.tmLanguage.json` and a local `.pikchr` sample.
