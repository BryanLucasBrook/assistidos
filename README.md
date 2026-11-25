# Assistidos

Lista de acompanhamento de séries, animes e filmes assistidos na Brasil TV.
Página estática (HTML + CSS + JS, sem build), publicada no GitHub Pages.

## O que faz
- Cadastro de série, anime ou filme, com temporadas e episódios.
- Marcação de episódios assistidos com um toque (ou temporada inteira).
- Recebe avisos da box HTV5 e marca o episódio sozinho.
- Cópia de segurança: exportar e importar a lista em JSON.

Os dados ficam no `localStorage` do navegador que abriu a página.

## Como a box avisa a página
A página lê um canal privado no [ntfy.sh](https://ntfy.sh) (o nome do canal aparece em **Ajustes**).
Para marcar um episódio, a box só precisa fazer:

```
POST https://ntfy.sh/<canal>
corpo: One Piece T1 E5
```

Formatos de texto aceitos:
- `One Piece T1 E5`, `Dark S02E03`, `Bleach 1x12`
- `Naruto - Episódio 12` (sem temporada: conta em sequência pelas temporadas cadastradas)
- `Duna` (filme)
- JSON: `{"titulo":"One Piece","temporada":1,"episodio":5}`

O título é comparado com o nome cadastrado e com os "outros nomes". O que não bater
fica na aba **Da box** para ligar manualmente; a página aprende o nome usado pela TV.

O ntfy.sh guarda mensagens por 12 horas. Abra a página pelo menos uma vez nesse intervalo.

Teste pelo terminal:
```
curl -d "One Piece T1 E5" https://ntfy.sh/<canal>
```
