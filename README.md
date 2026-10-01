# brasiluminado

Cada ponto é um estabelecimento com CNPJ ativo, posto no seu endereço do Censo IBGE 2022.

**https://rafapolo.github.io/brasiluminado/** · link direto para um estado: `#sp`, `#rj`, `#ba`…

## Dados

- Estabelecimentos ativos do cadastro de CNPJ da Receita Federal.
- Geolocalização por casamento exato de endereço com o CNEFE (Censo IBGE 2022), sem recurso ao
  centroide do CEP. Quem não casa fica fora do mapa; `data/meta.json` traz, por UF, quantos dos
  ativos foram geolocalizados.
- Vários estabelecimentos no mesmo endereço viram um ponto só.
- `data/br.bin.gz` é uma amostra de 2 milhões de pontos para a vista do Brasil. O DF ainda não tem arquivo.

### Formato de `data/<uf>.bin.gz`

gzip de três blocos contíguos para `n` pontos: `n` longitudes `float32`, `n` latitudes `float32`,
`n` pesos `uint16` (little-endian). O peso não é usado pelo mapa.

## Código

Página estática, sem build: `index.html`, `app.js`, `app.css` e `worker.js` (download e
descompressão fora da thread principal). MapLibre GL + deck.gl (`ScatterplotLayer` com mistura
aditiva). `thumbs/` são imagens estáticas de cada UF usadas na prévia do seletor.

Para rodar localmente:

```sh
python3 -m http.server 8000
```
