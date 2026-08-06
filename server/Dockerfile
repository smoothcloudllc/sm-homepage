FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Guard de integridad: falla en build si falta un archivo crítico (evita imagen rota en runtime).
RUN test -s src/schema.sql && test -s src/index.js || (echo "FALLO: src/schema.sql o src/index.js faltan o están vacíos en el contexto de build (¿distribución por git sin el fix?)" && exit 1)

# Directorio de uploads (logo de la empresa). Se monta como volumen nombrado
# en docker-compose; la propiedad es de node para que super_admin pueda subir.
RUN mkdir -p /app/public/uploads && chown node:node /app/public/uploads

# Ejecutar como usuario no-root (mejora de seguridad)
USER node

EXPOSE 3000

CMD ["node", "src/index.js"]
