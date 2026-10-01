# brasilumen

Cada ponto é um estabelecimento com CNPJ ativo, posto no seu endereço do Censo IBGE 2022.

**https://rafapolo.github.io/brasilumen/** · link direto para um estado: `#sp`, `#rj`, `#ba`…

## Dados

- Estabelecimentos ativos do cadastro de CNPJ da Receita Federal.
- Geolocalização por casamento exato de endereço com o CNEFE (Censo IBGE 2022), sem recurso ao
  centroide do CEP. Quem não casa fica fora do mapa; `data/meta.json` traz, por UF, quantos dos
  ativos foram geolocalizados.
- Vários estabelecimentos no mesmo endereço viram um ponto só.
- `data/br.bin.gz` é uma amostra de 2 milhões de pontos para a vista do Brasil. O DF ainda não tem arquivo.

### Formato de `data/<uf>.bin.gz`

Compactado por `scripts/repack.py` a partir da saída do extrator (`n` longitudes `float32`,
`n` latitudes `float32`, `n` pesos `uint16`): pontos numa grade de 1e-5° (~1,1 m), em ordem de
Morton, gravados como deltas em varint e comprimidos com gzip, cerca de 3,5× menor. O peso não é
usado pelo mapa e fica de fora. Rode `python3 scripts/repack.py` depois de extrair dados novos;
arquivos já compactados são ignorados.

## Código

Página estática, sem build: `index.html`, `app.js`, `app.css` e `worker.js` (download e
decodificação fora da thread principal). MapLibre GL com uma camada WebGL própria que desenha
cada estabelecimento como um ponto com mistura aditiva. De longe, onde centenas de pontos caem no
mesmo pixel, o worker junta os pontos de cada célula da grade num ponto só que carrega a contagem e
soma a mesma luz; a camada só usa um nível cujas células ficam abaixo de ⅓ de pixel, então a imagem
não muda.

Ao mudar `app.js`, `app.css` ou `worker.js`, suba o `?v=` em `index.html` e em `app.js`, para o
cache do GitHub Pages não misturar versões. `thumbs/` são imagens estáticas de cada UF usadas na prévia do seletor.

Para rodar localmente:

```sh
python3 -m http.server 8000
```
