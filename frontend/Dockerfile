FROM node:18

WORKDIR /app
COPY frontend/package.json frontend/vite.config.js ./
COPY frontend/src ./src
COPY frontend/public ./public
RUN npm install
RUN npm run build

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
