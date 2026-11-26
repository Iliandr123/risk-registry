package uptime.app.risks;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doReturn;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;
import static uptime.app.http.SessionCookie.CSRF_HEADER;
import static uptime.app.http.SessionCookie.NAME;

import jakarta.servlet.http.Cookie;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest
@AutoConfigureMockMvc
@Testcontainers
class RiskRegisterIntegrationTest {
    private static final String RISKS = "/api/risks";

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
    @MockitoSpyBean RiskCalendar calendar;

    private Client author;
    private Client reviewer;
    private Client reader;

    @BeforeEach
    void prepare() throws Exception {
        jdbc.sql("TRUNCATE risk_events, risk_versions, risks, sessions, accounts").update();
        author = member("Автор", false);
        reviewer = member("Ревьюер", true);
        reader = member("Участник", false);
        date("2026-01-31");
    }

    @Test
    void validatesDraftsAndPublishesSelfReviewWithStableRiskId() throws Exception {
        mutate(post(RISKS), author, Map.of("impact", 10.5)).andExpect(status().isBadRequest());
        mutate(post(RISKS), author, Map.of("likelihood", 0)).andExpect(status().isBadRequest());
        var draft = create(reviewer, Map.of());
        view(draft.path() + "/draft", reviewer).andExpect(jsonPath("$.fields.ownerId").value(reviewer.id().toString()));
        view(draft.path() + "/draft", author).andExpect(status().isNotFound());
        view(draft.path() + "/history", author).andExpect(status().isNotFound());
        view(draft.path(), reviewer).andExpect(status().isNotFound());
        view(RISKS, author).andExpect(jsonPath("$.items.length()").value(0));
        action(draft, "submit", reviewer, null).andExpect(status().isBadRequest());

        draft = save(draft, reviewer, fields("Первый риск", 2, 9));
        var submitted = step(draft, "submit", reviewer, null);
        view(RISKS + "?view=review", reviewer).andExpect(jsonPath("$.items[0].versionId").value(draft.version()));
        view(RISKS + "?view=review", author).andExpect(status().isForbidden());
        action(submitted, "approve", author, null).andExpect(status().isForbidden());
        action(submitted, "return", reviewer, " ").andExpect(status().isBadRequest());
        var returned = step(submitted, "return", reviewer, "Уточнить событие");
        view(draft.path() + "/history", reviewer).andExpect(jsonPath("$.events[1].comment").value("Уточнить событие"));
        var corrected = save(returned, reviewer, Map.of("possibleEvent", "Уточнённое событие"));
        step(step(corrected, "submit", reviewer, null), "approve", reviewer, null);
        view(draft.path(), reader).andExpect(status().isOk())
                .andExpect(jsonPath("$.riskId").value(draft.risk()))
                .andExpect(jsonPath("$.snapshot.versionId").value(draft.version()))
                .andExpect(jsonPath("$.snapshot.possibleEvent").value("Уточнённое событие"))
                .andExpect(jsonPath("$.snapshot.priority.score").value(18))
                .andExpect(jsonPath("$.snapshot.priority.category").value("LOW"))
                .andExpect(jsonPath("$.snapshot.priority.criticalImpact").value(true));
        publish(author, fields("Высокий", 4, 10));
        publish(author, fields("Средний", 4, 5));
        view(RISKS, reader).andExpect(jsonPath("$.items[*].priority.category",
                org.hamcrest.Matchers.contains("HIGH", "MEDIUM", "LOW")));
        view(RISKS + "?q=УТОЧНЁННОЕ&ownerId=" + reviewer.id() + "&category=LOW", reader)
                .andExpect(jsonPath("$.items.length()").value(1))
                .andExpect(jsonPath("$.items[0].riskId").value(draft.risk()));
    }

    @Test
    void databaseRejectsSecondOpenVersionAndCrossRiskReferences() throws Exception {
        var first = create(author, Map.of());
        var second = create(author, Map.of());
        assertThatThrownBy(() -> jdbc.sql("""
                INSERT INTO risk_versions (id, risk_id, author_id, status) VALUES (?, ?, ?, 'RETURNED')
                """).param(UUID.randomUUID()).param(UUID.fromString(first.risk())).param(author.id()).update())
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("risk_versions_one_open_idx");
        assertThatThrownBy(() -> jdbc.sql("""
                UPDATE risks SET published_version_id = ?, assessment_date = CURRENT_DATE WHERE id = ?
                """).param(UUID.fromString(second.version())).param(UUID.fromString(first.risk())).update())
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("risks_published_version_fk");
        assertThatThrownBy(() -> jdbc.sql("""
                INSERT INTO risk_events (risk_id, version_id, actor_id, action, occurred_at)
                VALUES (?, ?, ?, 'APPROVE', CURRENT_TIMESTAMP)
                """).param(UUID.fromString(first.risk())).param(UUID.fromString(second.version()))
                .param(reviewer.id()).update()).isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void concurrentWithdrawAndApprovalCommitExactlyOneTransition() throws Exception {
        var published = publish(author, fields("Опубликованный текст", 4, 5));
        var edit = open(published, author);
        mutate(post(published.path() + "/draft"), reader, expected(published)).andExpect(status().isConflict());
        edit = save(edit, author, Map.of("title", "Новый текст"));
        var submitted = step(edit, "submit", author, null);
        mutate(patch(submitted.path() + "/draft"), author, changes(submitted, Map.of("title", "Поздняя правка")))
                .andExpect(status().isConflict());
        view(published.path(), reader).andExpect(jsonPath("$.snapshot.title").value("Опубликованный текст"));

        var start = new CountDownLatch(1);
        int approved;
        int withdrawn;
        try (var workers = Executors.newFixedThreadPool(2)) {
            var a = workers.submit(() -> {
                assertThat(start.await(10, TimeUnit.SECONDS)).isTrue();
                return action(submitted, "approve", reviewer, null).andReturn().getResponse().getStatus();
            });
            var w = workers.submit(() -> {
                assertThat(start.await(10, TimeUnit.SECONDS)).isTrue();
                return action(submitted, "withdraw", author, null).andReturn().getResponse().getStatus();
            });
            start.countDown();
            approved = a.get(10, TimeUnit.SECONDS);
            withdrawn = w.get(10, TimeUnit.SECONDS);
        }
        assertThat(new int[] {approved, withdrawn}).containsExactlyInAnyOrder(200, 409);
        boolean changed = approved == 200;
        view(published.path(), reader)
                .andExpect(jsonPath("$.snapshot.versionId").value(changed ? submitted.version() : published.version()))
                .andExpect(jsonPath("$.hasOpenDraft").value(false));
        view(published.path() + "/history", author)
                .andExpect(jsonPath("$.publishedVersions.length()").value(changed ? 2 : 1))
                .andExpect(jsonPath("$.events.length()").value(4))
                .andExpect(jsonPath("$.events[3].action").value(changed ? "APPROVE" : "WITHDRAW"));
    }

    @Test
    void closesFirstProposalsAndUnblocksPrivateEditsWithoutDisclosingTheirContent() throws Exception {
        var first = create(author, fields("Первое предложение", 4, 5));
        action(first, "unblock", reviewer, "Закрываю").andExpect(status().isNotFound());
        var submitted = step(first, "submit", author, null);
        step(submitted, "withdraw", author, "Подам снова");
        view(RISKS + "?view=review", reviewer).andExpect(jsonPath("$.items.length()").value(0));
        view(first.path() + "/history", reviewer).andExpect(jsonPath("$.events[1].comment").value("Подам снова"));
        view(first.path() + "/history", reader).andExpect(status().isNotFound());

        var replacement = create(author, fields("Новое предложение", 4, 5));
        assertThat(replacement.risk()).isNotEqualTo(first.risk());
        var returned = step(step(replacement, "submit", author, null), "return", reviewer, "Исправьте");
        action(returned, "unblock", reviewer, null).andExpect(status().isBadRequest());
        step(returned, "unblock", reviewer, "Решили закрыть");
        view(RISKS + "?view=mine", author).andExpect(jsonPath("$.items[*].status",
                org.hamcrest.Matchers.containsInAnyOrder("WITHDRAWN", "CLOSED")));
        view(replacement.path() + "/history", author).andExpect(jsonPath("$.events[2].comment").value("Решили закрыть"));

        var published = publish(author, fields("Общая версия", 4, 5));
        var secret = save(open(published, reader), reader, Map.of("title", "Приватный текст"));
        view(published.path(), reviewer).andExpect(jsonPath("$.hasOpenDraft").value(true))
                .andExpect(jsonPath("$.unblock.versionId").value(secret.version()))
                .andExpect(jsonPath("$.unblock.revision").value((int) secret.revision()))
                .andExpect(jsonPath("$.unblock.authorDisplayName").value("Участник"))
                .andExpect(jsonPath("$.unblock.fields").doesNotExist())
                .andExpect(jsonPath("$.snapshot.title").value("Общая версия"));
        view(published.path(), author).andExpect(jsonPath("$.unblock").doesNotExist());
        view(published.path() + "/draft", reviewer).andExpect(status().isNotFound());
        step(secret, "unblock", reviewer, "Освобождаю карточку");
        view(published.path() + "/history", reviewer).andExpect(jsonPath("$.events.length()").value(2));
        view(published.path() + "/history", reader)
                .andExpect(jsonPath("$.events[1].comment").value("Освобождаю карточку"));
        var reopened = open(published, author);
        assertThat(reopened.version()).isNotEqualTo(secret.version());
        step(reopened, "withdraw", author, null);
        assertThat(open(published, reviewer).version()).isNotEqualTo(reopened.version());
    }

    @Test
    void confirmsCurrentSnapshotWithoutTouchingEditAndArchivesWithHistory() throws Exception {
        var initial = publish(author, fields("Оценка", 4, 5));
        date("2026-04-30");
        view(initial.path(), reader).andExpect(jsonPath("$.assessment.reviewDueDate").value("2026-04-30"))
                .andExpect(jsonPath("$.assessment.reviewRequired").value(true));
        var edit = save(open(initial, author), author, Map.of("title", "Новый текст"));
        mutate(post(initial.path() + "/assessment/confirm"), reviewer, expected(initial))
                .andExpect(status().isOk()).andExpect(jsonPath("$.assessment.date").value("2026-04-30"))
                .andExpect(jsonPath("$.assessment.reviewRequired").value(false));
        view(initial.path() + "/draft", author).andExpect(jsonPath("$.revision").value((int) edit.revision()))
                .andExpect(jsonPath("$.status").value("DRAFT"))
                .andExpect(jsonPath("$.fields.title").value("Новый текст"));
        date("2026-05-02");
        var textOnly = step(step(edit, "submit", author, null), "approve", reviewer, null);
        mutate(post(initial.path() + "/assessment/confirm"), reviewer, expected(initial))
                .andExpect(status().isConflict());
        view(initial.path(), author).andExpect(jsonPath("$.assessment.date").value("2026-04-30"));
        var reassessed = save(open(textOnly, author), author, Map.of("impact", 10));
        reassessed = step(step(reassessed, "submit", author, null), "approve", reviewer, null);
        view(initial.path(), reader).andExpect(jsonPath("$.assessment.date").value("2026-05-02"));

        var closing = save(open(reassessed, author), author, Map.of("riskState", "REMOVED"));
        closing = step(closing, "submit", author, null);
        action(closing, "approve", reviewer, null).andExpect(status().isBadRequest());
        closing = save(step(closing, "return", reviewer, "Укажите причину"), author,
                Map.of("closureReason", "Устранена причина"));
        step(step(closing, "submit", author, null), "approve", reviewer, null);
        view(RISKS, reader).andExpect(jsonPath("$.items.length()").value(0));
        view(RISKS + "?view=archive", reader).andExpect(jsonPath("$.items[0].riskId").value(initial.risk()));
        view(initial.path(), reader).andExpect(jsonPath("$.snapshot.closureReason").value("Устранена причина"));
        view(initial.path() + "/history", reader).andExpect(jsonPath("$.publishedVersions.length()").value(4))
                .andExpect(jsonPath("$.publishedVersions[0].title").value("Оценка"))
                .andExpect(jsonPath("$.publishedVersions[0].impact").value(5))
                .andExpect(jsonPath("$.events[1].action").value("CONFIRM_ASSESSMENT"));
    }

    @Test
    void rechecksNewOwnersOnApprovalButAllowsAnUnchangedDisabledOwner() throws Exception {
        Client admin = member("Администратор", false, true);
        var fields = new LinkedHashMap<>(fields("Риск с владельцем", 4, 5));
        fields.put("ownerId", reader.id());
        var first = step(create(author, fields), "submit", author, null);
        setActive(admin, reader, false);
        action(first, "approve", reviewer, null).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("OWNER_INACTIVE"));
        view(first.path(), reviewer).andExpect(status().isNotFound());
        view(first.path() + "/draft", reviewer).andExpect(jsonPath("$.status").value("IN_REVIEW"))
                .andExpect(jsonPath("$.revision").value((int) first.revision()));
        var replaced = save(step(first, "return", reviewer, "Замените владельца"), author,
                Map.of("ownerId", author.id()));
        var published = step(step(replaced, "submit", author, null), "approve", reviewer, null);
        setActive(admin, reader, true);
        var transfer = save(open(published, author), author, Map.of("ownerId", reader.id()));
        transfer = step(transfer, "submit", author, null);
        setActive(admin, reader, false);
        action(transfer, "approve", reviewer, null).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("OWNER_INACTIVE"));
        view(published.path(), reviewer).andExpect(jsonPath("$.snapshot.versionId").value(published.version()));
        step(transfer, "withdraw", author, null);
        var keepsOwner = save(open(published, reviewer), reviewer, Map.of("decisionNote", "Проверить позже"));
        keepsOwner = step(keepsOwner, "submit", reviewer, null);
        setActive(admin, author, false);
        step(keepsOwner, "approve", reviewer, null);
        view(published.path(), reviewer).andExpect(jsonPath("$.snapshot.owner.id").value(author.id().toString()))
                .andExpect(jsonPath("$.snapshot.owner.active").value(false))
                .andExpect(jsonPath("$.snapshot.decisionNote").value("Проверить позже"));
    }

    private ResultActions view(String path, Client actor) throws Exception {
        return mvc.perform(get(path).cookie(actor.cookie()));
    }

    private ResultActions mutate(MockHttpServletRequestBuilder request, Client actor, Object body) throws Exception {
        return mvc.perform(request.cookie(actor.cookie()).header(CSRF_HEADER, actor.csrf())
                .contentType("application/json").content(json.writeValueAsBytes(body)));
    }

    private Draft create(Client actor, Map<String, ?> fields) throws Exception {
        return draft(mutate(post(RISKS), actor, fields).andExpect(status().isCreated()));
    }

    private Draft open(Draft published, Client actor) throws Exception {
        return draft(mutate(post(published.path() + "/draft"), actor, expected(published)).andExpect(status().isCreated()));
    }

    private Draft save(Draft draft, Client actor, Map<String, ?> fields) throws Exception {
        return draft(mutate(patch(draft.path() + "/draft"), actor, changes(draft, fields)).andExpect(status().isOk()));
    }

    private Draft step(Draft draft, String verb, Client actor, String comment) throws Exception {
        return draft(action(draft, verb, actor, comment).andExpect(status().isOk()));
    }

    private ResultActions action(Draft draft, String verb, Client actor, String comment) throws Exception {
        var body = new LinkedHashMap<String, Object>();
        body.put("versionId", draft.version());
        body.put("expectedRevision", draft.revision());
        if (comment != null) {
            body.put("comment", comment);
        }
        return mutate(post(draft.path() + "/draft/" + verb), actor, body);
    }

    private Draft publish(Client actor, Map<String, ?> fields) throws Exception {
        return step(step(create(actor, fields), "submit", actor, null), "approve", reviewer, null);
    }

    private Draft draft(ResultActions result) throws Exception {
        JsonNode body = body(result);
        return new Draft(body.get("riskId").asText(), body.get("versionId").asText(), body.get("revision").asLong());
    }

    private JsonNode body(ResultActions result) throws Exception {
        return json.readTree(result.andReturn().getResponse().getContentAsByteArray());
    }

    private Client member(String name, boolean review) throws Exception {
        return member(name, review, false);
    }

    private Client member(String name, boolean review, boolean admin) throws Exception {
        UUID id = UUID.randomUUID();
        jdbc.sql("""
                INSERT INTO accounts (id, login, display_name, password_hash, must_change_password, active, is_admin, is_reviewer)
                VALUES (?, ?, ?, 'fixture', false, true, ?, ?)
                """).param(id).param(id.toString()).param(name).param(admin).param(review).update();
        byte[] value = new byte[32];
        new java.security.SecureRandom().nextBytes(value);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(value);
        jdbc.sql("INSERT INTO sessions VALUES (?, ?, CURRENT_TIMESTAMP + INTERVAL '1 hour')")
                .param(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.US_ASCII)))
                .param(id).update();
        var cookie = new Cookie(NAME, token);
        var csrf = body(mvc.perform(get("/api/csrf").cookie(cookie)).andExpect(status().isOk())).get("token").asText();
        return new Client(id, cookie, csrf);
    }

    private void setActive(Client admin, Client target, boolean active) throws Exception {
        mutate(patch("/api/admin/accounts/" + target.id()), admin, Map.of("active", active)).andExpect(status().isOk());
    }

    private void date(String date) {
        doReturn(OffsetDateTime.parse(date + "T14:00:00Z")).when(calendar).now();
    }

    private static Map<String, ?> expected(Draft snapshot) {
        return Map.of("expectedPublishedVersionId", snapshot.version());
    }

    private static Map<String, ?> changes(Draft draft, Map<String, ?> fields) {
        return Map.of("versionId", draft.version(), "expectedRevision", draft.revision(), "fields", fields);
    }

    private static Map<String, Object> fields(String title, int likelihood, int impact) {
        return Map.of("title", title, "cause", "Причина", "possibleEvent", "Событие",
                "productConsequences", "Последствия", "likelihood", likelihood, "impact", impact);
    }

    private record Draft(String risk, String version, long revision) {
        String path() {
            return RISKS + "/" + risk;
        }
    }

    private record Client(UUID id, Cookie cookie, String csrf) {}
}
