package uptime.app.risks;

import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import uptime.app.accounts.AccountDirectory.Member;
import uptime.app.http.ApiProblem;

@RestController
class RiskGroupController {
    private static final Pattern EDGE_WHITESPACE = Pattern.compile("(?U)^\\s+|\\s+$");
    private final RiskGroupStore groups;

    RiskGroupController(RiskGroupStore groups) {
        this.groups = groups;
    }

    @GetMapping("/api/risk-groups")
    List<RiskGroup> list() {
        return groups.list();
    }

    @PostMapping("/api/admin/risk-groups")
    @ResponseStatus(HttpStatus.CREATED)
    RiskGroup create(@RequestAttribute(RiskAccess.MEMBER_ATTRIBUTE) Member member, @RequestBody JsonNode body) {
        return save(member, null, body);
    }

    @PatchMapping("/api/admin/risk-groups/{id}")
    RiskGroup rename(@RequestAttribute(RiskAccess.MEMBER_ATTRIBUTE) Member member, @PathVariable("id") String id,
                     @RequestBody JsonNode body) {
        return save(member, id, body);
    }

    private RiskGroup save(Member member, String id, JsonNode body) {
        if (!member.admin()) {
            throw ApiProblem.forbidden();
        }
        JsonNode value = body.get("name");
        if (!body.isObject() || body.size() != 1 || value == null || !value.isTextual()) {
            throw ApiProblem.invalidRequest();
        }
        String name = EDGE_WHITESPACE.matcher(value.asText()).replaceAll("");
        String normalizedName = name.toLowerCase(Locale.ROOT);
        if (name.isEmpty() || name.indexOf('\0') >= 0 || normalizedName.equals("без группы")) {
            throw ApiProblem.invalidRequest();
        }
        var group = new RiskGroup(id == null ? UUID.randomUUID() : RiskController.pathId(id), name);
        try {
            if (id == null) {
                groups.insert(group, normalizedName);
            } else if (!groups.rename(group, normalizedName)) {
                throw ApiProblem.notFound();
            }
        } catch (DuplicateKeyException exception) {
            throw new ApiProblem(409, "RISK_GROUP_NAME_CONFLICT", "Группа с таким названием уже существует.");
        }
        return group;
    }
}
