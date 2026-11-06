# MDReader pour VS Code

Lecteur Markdown rapide : le moteur de rendu est le même que celui de [MDReader pour Windows](https://github.com/joshsssn/MDReader) (Rust, compilé en WebAssembly).

- Sommaire, recherche instantanée, maths KaTeX hors ligne, 7 thèmes, mode nuit
- Lecture seule, rechargement automatique quand le fichier change
- Ouvrir : clic droit sur un `.md` > **Ouvrir avec… > MDReader**, ou le bouton de la barre d'onglet

Pour l'utiliser par défaut :
```json
"workbench.editorAssociations": { "*.md": "mdreader.viewer" }
```
