# Cloning with Zit in VS Code

Run **Zit: Clone Repository** from the Command Palette or Source Control welcome view.

1. Enter the complete remote URI, including its scheme.
2. Choose the final checkout directory. The extension passes that directory directly as `DIR` in `zit clone URL DIR`.
3. After the clone succeeds, choose **Open Repository** if you want to open the new checkout.

Canceling the URI or destination prompt aborts without opening a repository. Authentication and certificate diagnostics come from Zit and are shown without alteration; use **Zit: Show Output** for the complete diagnostic.

The extension runs the Zit clone workflow and then offers to open the resulting checkout. A cloned checkout contains `.zit` and `.zit-checkout`; discovery follows the regular `.zit-checkout` file so detached worktrees whose store lives elsewhere also work. If cloning fails, run the reported `zit clone` command in the integrated terminal to diagnose credentials, connectivity, or certificate configuration.
