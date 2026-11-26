package uptime.app.risks;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
class RiskCalendar {
    private final ZoneId zone;

    RiskCalendar(@Value("${risk.register.team.time.zone:UTC}") String zone) {
        this.zone = ZoneId.of(zone);
    }

    OffsetDateTime now() {
        return OffsetDateTime.now(zone);
    }

    LocalDate today() {
        return now().toLocalDate();
    }
}
