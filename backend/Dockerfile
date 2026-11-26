FROM eclipse-temurin:25-jdk AS build
WORKDIR /app/backend
COPY backend/ ./
COPY api/openapi.yml /app/api/openapi.yml
RUN sh ./gradlew --no-daemon bootJar

FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=build /app/backend/build/libs/uptime-backend-0.1.0.jar app.jar
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
