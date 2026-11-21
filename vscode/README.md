# MDReader pour VS Code

Lecteur et éditeur Markdown rapide : le moteur de rendu est le même que celui de [MDReader pour Windows](https://github.com/joshsssn/MDReader) (Rust, compilé en WebAssembly).

- Sommaire, recherche instantanée, maths KaTeX hors ligne, 7 thèmes, mode nuit
- Nombre de caractères, temps de lecture et estimation de tokens dans la barre
- **Éditeur intégré** : interrupteur Édition / Lecture, vue Rendu (WYSIWYG, syntaxe Markdown reconnue à la frappe) ou Source, éditeur d'équations où la formule se modifie directement
- Enregistrement par VS Code (`Ctrl+S`, point « modifié » sur l'onglet, confirmation à la fermeture) ; seuls les blocs modifiés du fichier sont réécrits
- Rechargement automatique quand le fichier change
- Ouvrir : clic droit sur un `.md` > **Ouvrir avec… > MDReader**, ou le bouton de la barre d'onglet

Pour l'utiliser par défaut :
```json
"workbench.editorAssociations": { "*.md": "mdreader.viewer" }
```
