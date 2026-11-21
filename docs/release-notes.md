**MDReader 1.1** : le lecteur devient aussi un éditeur.

**Installation :** télécharger `MDReader.exe` ci-dessous et le lancer. Pas d'installeur ; nécessite WebView2 (déjà présent sur Windows 11). L'exe n'étant pas signé, Windows SmartScreen peut demander une confirmation (« Informations complémentaires » → « Exécuter quand même »).

### Nouveautés (application Windows, extension VS Code et version web)
- **Éditeur intégré** pour les `.md` et les `.txt` : interrupteur **Édition / Lecture** dans la barre (`Ctrl+E`), nouveau document
- **Markdown, vue Rendu** : édition directe du document mis en forme, barre d'outils (titres, gras, italique, souligné, barré, code, lien, image, listes, cases à cocher, citation, encadrés, bloc de code, formule, tableau, séparateur, note de bas de page)
- **Syntaxe Markdown reconnue à la frappe** : `### `, `- `, `1. `, `> `, ```` ``` ````, `$$`, `---`, `| a | b |`, `**gras**`, `$x^2$`, `[texte](lien)`…
- **Vue Source** (`Ctrl+Maj+E`) pour retoucher le Markdown brut
- **Éditeur d'équations** : la formule se modifie directement, comme dans Word (cases de matrice, fractions, exposants cliquables), avec palettes de symboles
- **Enregistrer** (`Ctrl+S`), **Enregistrer sous** (`Ctrl+Maj+S`), annuler / rétablir, confirmation avant de perdre des modifications
- **Fidélité** : seuls les blocs modifiés sont réécrits, le reste du fichier est conservé à l'octet près
- Fluide sur de très gros fichiers (testé sur 1,6 million de caractères)
- **Statistiques** dans la barre : nombre de caractères, temps de lecture et estimation de tokens (1 pour 4 caractères)

### Changement de raccourci
- L'export HTML passe sur `Ctrl+Maj+H` (`Ctrl+S` enregistre ; en lecture, sans modification en attente, il exporte encore en HTML)

### Extension VS Code
`mdreader-1.1.0.vsix` : même moteur, même lecteur et même éditeur. L'enregistrement passe par VS Code (`Ctrl+S`, point « modifié » sur l'onglet, confirmation à la fermeture).

Installation : `Ctrl+Maj+P` → **Extensions: Install from VSIX…**, ou `code --install-extension mdreader-1.1.0.vsix`.

### Version web / mobile (PWA)
https://joshsssn.github.io/MDReader/ : lecteur et éditeur, mis à jour automatiquement. Sur Chrome et Edge (ordinateur), l'enregistrement modifie directement le fichier ; ailleurs, il télécharge le fichier modifié.
