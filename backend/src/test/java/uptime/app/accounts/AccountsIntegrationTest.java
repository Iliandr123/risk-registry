package uptime.app.accounts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;
import static uptime.app.http.SessionCookie.CSRF_HEADER;
import static uptime.app.http.SessionCookie.NAME;

import jakarta.servlet.http.Cookie;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import uptime.app.Main;

@SpringBootTest
@AutoConfigureMockMvc
@Testcontainers
class AccountsIntegrationTest {
    private static final String CSRF_COOKIE = "__Host-risk_csrf";
    private static final String PASSWORD = "fixture replacement password";
    private static final AtomicInteger SCENARIO = new AtomicInteger();

    @Container
    static final PostgreSQLContainer DATABASE = new PostgreSQLContainer("postgres:17-alpine");

    @DynamicPropertySource
    static void datasource(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", DATABASE::getJdbcUrl);
        registry.add("spring.datasource.username", DATABASE::getUsername);
        registry.add("spring.datasource.password", DATABASE::getPassword);
    }

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired JdbcClient jdbc;
    @Autowired FirstAdministrator bootstrap;
    private String address;
    private String prefix;

    @BeforeEach
    void emptyAccounts() {
        jdbc.sql("TRUNCATE sessions, accounts").update();
        int scenario = SCENARIO.incrementAndGet();
        address = "127.0.0." + scenario;
        prefix = "scenario-" + scenario + "-";
    }

    @Test
    void migrationIsAppliedOnceAndRestartPreservesAccountsAndSessions() throws Exception {
        String login = prefix + "admin";
        String temporary = bootstrap.create(login, "Администратор");
        Client session = login(login, temporary).client();
        List<String> migrations = jdbc.sql("SELECT id FROM databasechangelog").query(String.class).list();
        assertThat(migrations).contains("001-accounts");
        assertThat(jdbc.sql("SELECT password_hash FROM accounts").query(String.class).single())
                .isNotEqualTo(temporary);
        assertThat(jdbc.sql("SELECT octet_length(token_hash) FROM sessions").query(Integer.class).single())
                .isEqualTo(32);

        try (var restarted = new SpringApplicationBuilder(Main.class).web(WebApplicationType.NONE).run(
                "--spring.datasource.url=" + DATABASE.getJdbcUrl(),
                "--spring.datasource.username=" + DATABASE.getUsername(),
                "--spring.datasource.password=" + DATABASE.getPassword())) {
            JdbcClient restartedDb = restarted.getBean(JdbcClient.class);
            assertThat(restartedDb.sql("SELECT id FROM databasechangelog").query(String.class).list())
                    .containsExactlyInAnyOrderElementsOf(migrations);
            assertThat(restartedDb.sql("SELECT login FROM accounts").query(String.class).single()).isEqualTo(login);
            assertThat(restarted.getBean(AccountDirectory.class).findMember(session.cookie().getValue())).isPresent();
            assertThatThrownBy(() -> restarted.getBean(FirstAdministrator.class).create(prefix + "second", "Другой"))
                    .isInstanceOf(IllegalStateException.class);
        }
    }

    @Test
    void temporaryPasswordLimitsAccessAndRotationAndLogoutRevokeTheOldSession() throws Exception {
        String login = prefix + "admin";
        String temporary = bootstrap.create(login, "Администратор");
        Client anonymous = csrf(null);
        mvc.perform(json(post("/api/session").cookie(anonymous.cookie()), Map.of("login", login, "password", temporary)))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_REJECTED"));
        mvc.perform(get("/api/risks")).andExpect(status().isUnauthorized());
        Login signedIn = login(login, temporary);
        assertThat(signedIn.body().get("mustChangePassword").asBoolean()).isTrue();
        Client limited = signedIn.client();
        for (String path : List.of("/api/me", "/api/participants", "/api/admin/accounts", "/api/risks/example")) {
            mvc.perform(get(path).cookie(limited.cookie())).andExpect(status().isForbidden())
                    .andExpect(header().string("Cache-Control", "no-store"))
                    .andExpect(jsonPath("$.code").value("PASSWORD_CHANGE_REQUIRED"));
        }
        Client otherLimited = login(login, temporary).client();
        mvc.perform(json(auth(post("/api/me/password"), limited),
                Map.of("currentPassword", "wrong", "newPassword", PASSWORD)))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("INVALID_CURRENT_PASSWORD"));
        Client working = replace(limited, temporary);
        assertThat(working.cookie().getValue()).isNotEqualTo(limited.cookie().getValue());
        assertThat(working.csrf()).isNotEqualTo(limited.csrf());
        for (Client old : List.of(limited, otherLimited)) {
            mvc.perform(get("/api/me").cookie(old.cookie())).andExpect(status().isUnauthorized());
        }
        mvc.perform(get("/api/me").cookie(working.cookie())).andExpect(status().isOk())
                .andExpect(jsonPath("$.login").value(login))
                .andExpect(jsonPath("$.mustChangePassword").value(false));
        mvc.perform(delete("/api/session").cookie(working.cookie()).header(CSRF_HEADER, limited.csrf()))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_REJECTED"));
        mvc.perform(auth(delete("/api/session"), working)).andExpect(status().isNoContent())
                .andExpect(header().string("Set-Cookie", org.hamcrest.Matchers.containsString("Max-Age=0")));
        mvc.perform(get("/api/me").cookie(working.cookie())).andExpect(status().isUnauthorized());
    }

    @Test
    void loginRateLimitDoesNotDiscloseWhetherTheAccountExists() throws Exception {
        String login = prefix + "missing";
        Client anonymous = csrf(null);
        for (int attempt = 0; attempt < 5; attempt++) {
            mvc.perform(loginRequest(anonymous, login, PASSWORD))
                    .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("INVALID_CREDENTIALS"));
        }
        mvc.perform(loginRequest(anonymous, login, PASSWORD)).andExpect(status().isTooManyRequests())
                .andExpect(header().exists("Retry-After")).andExpect(header().doesNotExist("Set-Cookie"))
                .andExpect(jsonPath("$.code").value("LOGIN_RATE_LIMITED"));
        assertThat(jdbc.sql("SELECT count(*) FROM sessions").query(Long.class).single()).isZero();
    }

    @Test
    void rolesAreIndependentAndRoleChangeResetAndDisableRevokeAllSessions() throws Exception {
        Client admin = startAdmin();
        mvc.perform(get("/api/me").cookie(admin.cookie())).andExpect(jsonPath("$.isAdmin").value(true))
                .andExpect(jsonPath("$.isReviewer").value(false));
        String login = prefix + "participant";
        LoginAs created = create(admin, login, false, true);
        Client reviewer = replace(login(login, created.temporary()).client(), created.temporary());
        Client second = login(login, PASSWORD).client();
        mvc.perform(auth(post("/api/admin/accounts/" + created.id() + "/reset-password"), reviewer))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("FORBIDDEN"));
        mvc.perform(json(auth(patch("/api/admin/accounts/" + created.id()), admin), Map.of("isAdmin", true)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.isReviewer").value(true));
        for (Client old : List.of(reviewer, second)) {
            mvc.perform(get("/api/me").cookie(old.cookie())).andExpect(status().isUnauthorized());
        }

        Client promoted = login(login, PASSWORD).client();
        Client promotedSecond = login(login, PASSWORD).client();
        var reset = mvc.perform(auth(post("/api/admin/accounts/" + created.id() + "/reset-password"), admin))
                .andExpect(status().isOk()).andExpect(jsonPath("$.account.mustChangePassword").value(true))
                .andReturn().getResponse();
        for (Client old : List.of(promoted, promotedSecond)) {
            mvc.perform(get("/api/me").cookie(old.cookie())).andExpect(status().isUnauthorized());
        }
        String resetPassword = body(reset).get("temporaryPassword").asString();
        Client mustChange = login(login, resetPassword).client();
        mvc.perform(json(auth(patch("/api/admin/accounts/" + created.id()), admin), Map.of("active", false)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.active").value(false));
        mvc.perform(get("/api/me").cookie(mustChange.cookie())).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/participants").cookie(admin.cookie())).andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1));
        mvc.perform(get("/api/admin/accounts").cookie(admin.cookie())).andExpect(status().isOk())
                .andExpect(jsonPath("$[*].temporaryPassword").isEmpty());
    }

    @Test
    void disabledAccountCannotSignInAndCanBeReenabledWithoutRestoringOldSessions() throws Exception {
        Client admin = startAdmin();
        String login = prefix + "participant";
        LoginAs created = create(admin, login, false, false);
        Client old = login(login, created.temporary()).client();
        String path = "/api/admin/accounts/" + created.id();
        mvc.perform(json(auth(patch(path), admin), Map.of("active", false))).andExpect(status().isOk());
        mvc.perform(loginRequest(csrf(null), login, created.temporary())).andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("INVALID_CREDENTIALS"));
        mvc.perform(json(auth(patch(path), admin), Map.of("active", true))).andExpect(status().isOk());
        mvc.perform(get("/api/me").cookie(old.cookie())).andExpect(status().isUnauthorized());
        assertThat(login(login, created.temporary()).body().get("active").asBoolean()).isTrue();
    }

    @Test
    void simultaneousDemotionsLeaveOneActiveAdministrator() throws Exception {
        Client first = startAdmin();
        String firstId = body(mvc.perform(get("/api/me").cookie(first.cookie())).andReturn().getResponse())
                .get("id").asString();
        String login = prefix + "second";
        LoginAs created = create(first, login, true, false);
        Client second = replace(login(login, created.temporary()).client(), created.temporary());
        CountDownLatch start = new CountDownLatch(1);
        try (var workers = Executors.newFixedThreadPool(2)) {
            var demoteFirst = workers.submit(() -> demote(start, first, firstId));
            var demoteSecond = workers.submit(() -> demote(start, second, created.id()));
            start.countDown();
            assertThat(List.of(demoteFirst.get(10, TimeUnit.SECONDS), demoteSecond.get(10, TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder(200, 409);
        }
        assertThat(jdbc.sql("SELECT count(*) FROM accounts WHERE active AND is_admin").query(Long.class).single())
                .isEqualTo(1);
    }

    @Test
    void accountUpdatesRejectInputsOutsideTheContract() throws Exception {
        Client admin = startAdmin();
        LoginAs created = create(admin, prefix + "participant", false, false);
        for (Map<String, ?> invalid : List.of(Map.<String, Object>of(), Map.of("active", "false"),
                Map.of("displayName", "Another name"))) {
            mvc.perform(json(auth(patch("/api/admin/accounts/" + created.id()), admin), invalid))
                    .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
        }
        mvc.perform(json(auth(post("/api/admin/accounts"), admin),
                Map.of("login", prefix + "participant", "displayName", "Duplicate")))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("LOGIN_ALREADY_EXISTS"));
    }

    private int demote(CountDownLatch start, Client client, String id) throws Exception {
        start.await();
        var response = mvc.perform(json(auth(patch("/api/admin/accounts/" + id), client), Map.of("isAdmin", false)))
                .andReturn().getResponse();
        if (response.getStatus() == 409) {
            assertThat(body(response).get("code").asString()).isEqualTo("LAST_ACTIVE_ADMIN");
        }
        return response.getStatus();
    }

    private Client startAdmin() throws Exception {
        String login = prefix + "admin";
        String temporary = bootstrap.create(login, "Администратор");
        return replace(login(login, temporary).client(), temporary);
    }

    private LoginAs create(Client admin, String login, boolean adminRole, boolean reviewer) throws Exception {
        JsonNode result = body(mvc.perform(json(auth(post("/api/admin/accounts"), admin), Map.of(
                "login", login, "displayName", "Участник", "isAdmin", adminRole, "isReviewer", reviewer)))
                .andExpect(status().isCreated()).andExpect(header().string("Cache-Control", "no-store"))
                .andReturn().getResponse());
        return new LoginAs(result.get("account").get("id").asString(), result.get("temporaryPassword").asString());
    }

    private Client replace(Client client, String temporary) throws Exception {
        var response = mvc.perform(json(auth(post("/api/me/password"), client),
                Map.of("currentPassword", temporary, "newPassword", PASSWORD)))
                .andExpect(status().isNoContent()).andReturn().getResponse();
        return csrf(response.getCookie(NAME));
    }

    private Login login(String login, String password) throws Exception {
        var response = mvc.perform(loginRequest(csrf(null), login, password)).andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "no-store")).andReturn().getResponse();
        Cookie cookie = response.getCookie(NAME);
        assertThat(cookie).isNotNull();
        assertThat(cookie.isHttpOnly()).isTrue();
        assertThat(cookie.getSecure()).isTrue();
        assertThat(cookie.getPath()).isEqualTo("/");
        assertThat(cookie.getAttribute("SameSite")).isEqualTo("Lax");
        return new Login(csrf(cookie), body(response));
    }

    private MockHttpServletRequestBuilder loginRequest(Client anonymous, String user, String password) {
        return json(auth(post("/api/session"), anonymous).with(request -> {
            request.setRemoteAddr(address);
            return request;
        }), Map.of("login", user, "password", password));
    }

    private Client csrf(Cookie cookie) throws Exception {
        var request = get("/api/csrf");
        if (cookie != null) {
            request.cookie(cookie);
        }
        var response = mvc.perform(request).andExpect(status().isOk()).andReturn().getResponse();
        return new Client(cookie == null ? response.getCookie(CSRF_COOKIE) : cookie,
                body(response).get("token").asString());
    }

    private JsonNode body(MockHttpServletResponse response) {
        return json.readTree(response.getContentAsByteArray());
    }

    private MockHttpServletRequestBuilder json(MockHttpServletRequestBuilder request, Map<String, ?> body) {
        return request.contentType("application/json").content(json.writeValueAsBytes(body));
    }

    private static MockHttpServletRequestBuilder auth(MockHttpServletRequestBuilder request, Client client) {
        return request.cookie(client.cookie()).header(CSRF_HEADER, client.csrf());
    }

    private record Client(Cookie cookie, String csrf) {}

    private record Login(Client client, JsonNode body) {}

    private record LoginAs(String id, String temporary) {}
}
