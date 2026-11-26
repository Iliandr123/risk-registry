package uptime.app.accounts;

import org.springframework.stereotype.Component;

@Component
public class FirstAdministrator {
    private final AccountService accounts;

    FirstAdministrator(AccountService accounts) {
        this.accounts = accounts;
    }

    public String create(String login, String displayName) {
        if (login.isBlank() || displayName.isBlank()) {
            throw new IllegalArgumentException("Укажите логин и имя первого администратора.");
        }
        return accounts.bootstrap(login, displayName).temporaryPassword();
    }
}
