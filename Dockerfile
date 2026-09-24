FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm install

COPY server server
COPY web web
RUN npm run build
RUN npm prune --omit=dev
# Only the LSTM "best_int" English model is used; drop the 10 MB legacy one.
RUN rm -rf node_modules/@tesseract.js-data/eng/4.0.0

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8097
ENV BUDGETPRO_DATA_DIR=/data

COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

VOLUME ["/data"]
EXPOSE 8097
CMD ["node", "server/dist/index.js"]
