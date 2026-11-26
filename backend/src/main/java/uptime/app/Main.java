package uptime.app;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.builder.SpringApplicationBuilder;
import uptime.app.accounts.FirstAdministrator;

@SpringBootApplication
public class Main {
    public static void main(String[] args) {
        if (args.length > 0 && args[0].equals("bootstrap-admin")) {
            if (args.length != 3) {
                throw new IllegalArgumentException("bootstrap-admin <логин> <имя>");
            }
            try (var context = new SpringApplicationBuilder(Main.class).web(WebApplicationType.NONE).run()) {
                String password = context.getBean(FirstAdministrator.class).create(args[1], args[2]);
                System.out.println("Временный пароль " + password);
            }
            return;
        }
        SpringApplication.run(Main.class, args);
    }
}
