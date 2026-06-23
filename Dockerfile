# Tiny, dependency-free image. Builders who don't have Node can just:
#   docker run --rm -p 8787:8787 -e MODELIS_HOST=0.0.0.0 ghcr.io/<you>/modelis-openai
FROM node:22-alpine
WORKDIR /app
COPY modelis-openai.mjs ./
ENV MODELIS_HOST=0.0.0.0 MODELIS_PORT=8787
EXPOSE 8787
USER node
ENTRYPOINT ["node", "modelis-openai.mjs"]
